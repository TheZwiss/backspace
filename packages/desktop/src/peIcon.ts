import fs from 'fs';
import zlib from 'zlib';

/**
 * The icon of a Windows program, read out of its .exe.
 *
 * A game run through Wine has no icon the Linux desktop knows: Steam's cache,
 * a Flatpak export or a .desktop entry exist only for games installed through
 * those. What every Windows game does have is the icon inside its executable,
 * in the PE resource section (RT_GROUP_ICON listing RT_ICON images). This
 * module reads that and returns a PNG.
 *
 * The file is untrusted input and may be hundreds of megabytes: it is never
 * read whole. Headers and resource tables are read by offset, every offset and
 * length is checked against the file size, and every count and size is capped,
 * so a corrupt or hostile file yields null rather than a crash or a huge
 * allocation.
 */

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

const MAX_SECTIONS = 96;
const MAX_DIR_ENTRIES = 4096;
const MAX_DIR_DEPTH = 3;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_ICON_PIXELS = 256;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Section {
  virtualAddress: number;
  span: number;
  rawPointer: number;
}

/** A file read by bounded offset; every read past the end is a miss. */
class BoundedFile {
  constructor(private readonly handle: fs.promises.FileHandle, readonly size: number) {}

  async read(offset: number, length: number): Promise<Buffer | null> {
    if (!Number.isInteger(offset) || !Number.isInteger(length)) return null;
    if (offset < 0 || length < 0 || offset + length > this.size) return null;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, offset);
    return bytesRead === length ? buffer : null;
  }
}

interface ResourceTree {
  file: BoundedFile;
  base: number;
  size: number;
  sections: Section[];
}

function rvaToOffset(sections: Section[], rva: number): number | null {
  for (const section of sections) {
    if (rva >= section.virtualAddress && rva < section.virtualAddress + section.span) {
      return section.rawPointer + (rva - section.virtualAddress);
    }
  }
  return null;
}

/** Entries of one resource directory table: [id or name offset, target]. */
async function directory(tree: ResourceTree, dirOffset: number): Promise<Array<{ id: number; named: boolean; target: number }> | null> {
  if (dirOffset < 0 || dirOffset + 16 > tree.size) return null;
  const header = await tree.file.read(tree.base + dirOffset, 16);
  if (!header) return null;
  const named = header.readUInt16LE(12);
  const ids = header.readUInt16LE(14);
  const count = named + ids;
  if (count > MAX_DIR_ENTRIES) return null;
  const raw = await tree.file.read(tree.base + dirOffset + 16, count * 8);
  if (!raw) return null;
  const entries: Array<{ id: number; named: boolean; target: number }> = [];
  for (let i = 0; i < count; i++) {
    const nameOrId = raw.readUInt32LE(i * 8);
    entries.push({ id: nameOrId & 0xffff, named: (nameOrId & 0x80000000) !== 0, target: raw.readUInt32LE(i * 8 + 4) });
  }
  return entries;
}

/**
 * The bytes of one resource: walk type → name → language, taking the first
 * entry at the levels below the type. `id` null takes the first name.
 */
async function readResource(tree: ResourceTree, type: number, id: number | null): Promise<Buffer | null> {
  let dirOffset = 0;
  for (let depth = 0; depth < MAX_DIR_DEPTH; depth++) {
    const entries = await directory(tree, dirOffset);
    if (!entries || entries.length === 0) return null;
    let entry: { id: number; named: boolean; target: number } | undefined;
    if (depth === 0) entry = entries.find((e) => !e.named && e.id === type);
    else if (depth === 1 && id !== null) entry = entries.find((e) => !e.named && e.id === id);
    else entry = entries[0];
    if (!entry) return null;

    if ((entry.target & 0x80000000) !== 0) {
      dirOffset = entry.target & 0x7fffffff;
      continue;
    }
    // A data entry: RVA, size, code page, reserved
    const dataEntry = await tree.file.read(tree.base + entry.target, 16);
    if (!dataEntry) return null;
    const rva = dataEntry.readUInt32LE(0);
    const size = dataEntry.readUInt32LE(4);
    const offset = rvaToOffset(tree.sections, rva);
    if (offset === null || size === 0 || size > MAX_RESOURCE_BYTES) return null;
    return tree.file.read(offset, size);
  }
  return null;
}

// ─── DIB → PNG ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode top-down RGBA pixels as an 8-bit RGBA PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An icon image stored as a DIB (BITMAPINFOHEADER, pixels bottom-up, then a
 * 1-bit transparency mask) as a PNG. Handles the depths icons use: 32, 24, 8
 * and 4 bits. Null for anything else or for a body that does not add up.
 */
export function dibToPng(dib: Buffer): Buffer | null {
  if (dib.length < 40) return null;
  const headerSize = dib.readUInt32LE(0);
  if (headerSize < 40 || headerSize > dib.length) return null;
  const width = dib.readInt32LE(4);
  const doubleHeight = dib.readInt32LE(8);
  const bits = dib.readUInt16LE(14);
  const compression = dib.readUInt32LE(16);
  const height = doubleHeight / 2; // the XOR image and the AND mask are stacked
  if (compression !== 0 || width <= 0 || height <= 0 || !Number.isInteger(height)) return null;
  if (width > MAX_ICON_PIXELS || height > MAX_ICON_PIXELS) return null;
  if (![4, 8, 24, 32].includes(bits)) return null;

  const paletteSize = bits <= 8 ? (dib.readUInt32LE(32) || 1 << bits) : 0;
  if (paletteSize > 256) return null;
  const paletteStart = headerSize;
  const pixelsStart = paletteStart + paletteSize * 4;
  const rowBytes = Math.floor((width * bits + 31) / 32) * 4;
  const maskRowBytes = Math.floor((width + 31) / 32) * 4;
  const maskStart = pixelsStart + rowBytes * height;
  if (maskStart + maskRowBytes * height > dib.length && bits !== 32) return null;
  if (pixelsStart + rowBytes * height > dib.length) return null;

  const rgba = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const src = pixelsStart + (height - 1 - y) * rowBytes; // bottom-up
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      let r = 0, g = 0, b = 0, a = 255;
      if (bits === 32) {
        b = dib[src + x * 4] as number;
        g = dib[src + x * 4 + 1] as number;
        r = dib[src + x * 4 + 2] as number;
        a = dib[src + x * 4 + 3] as number;
        if (a !== 0) anyAlpha = true;
      } else if (bits === 24) {
        b = dib[src + x * 3] as number;
        g = dib[src + x * 3 + 1] as number;
        r = dib[src + x * 3 + 2] as number;
      } else {
        const byte = dib[src + (bits === 8 ? x : x >> 1)] as number;
        const index = bits === 8 ? byte : (x & 1 ? byte & 0x0f : byte >> 4);
        const p = paletteStart + index * 4;
        if (index >= paletteSize) return null;
        b = dib[p] as number;
        g = dib[p + 1] as number;
        r = dib[p + 2] as number;
      }
      rgba[out] = r;
      rgba[out + 1] = g;
      rgba[out + 2] = b;
      rgba[out + 3] = a;
    }
  }

  // The mask decides transparency unless a 32-bit image carries its own alpha
  const useMask = bits !== 32 || !anyAlpha;
  if (useMask && maskStart + maskRowBytes * height <= dib.length) {
    for (let y = 0; y < height; y++) {
      const src = maskStart + (height - 1 - y) * maskRowBytes;
      for (let x = 0; x < width; x++) {
        const transparent = ((dib[src + (x >> 3)] as number) >> (7 - (x & 7))) & 1;
        if (transparent) rgba[(y * width + x) * 4 + 3] = 0;
        else if (bits === 32) rgba[(y * width + x) * 4 + 3] = 255;
      }
    }
  }
  return encodePng(width, height, rgba);
}

// ─── The reader ─────────────────────────────────────────────────────────────

interface GroupEntry {
  width: number;
  bits: number;
  id: number;
}

/** The images a RT_GROUP_ICON lists, largest and deepest first. */
function parseIconGroup(group: Buffer): GroupEntry[] {
  if (group.length < 6 || group.readUInt16LE(2) !== 1) return [];
  const count = Math.min(group.readUInt16LE(4), 64);
  const entries: GroupEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 14;
    if (at + 14 > group.length) break;
    entries.push({
      width: group[at] === 0 ? 256 : (group[at] as number),
      bits: group.readUInt16LE(at + 6),
      id: group.readUInt16LE(at + 12),
    });
  }
  return entries.sort((a, b) => b.width - a.width || b.bits - a.bits);
}

/**
 * The best icon of a PE file as PNG bytes of at most `maxBytes`, or null when
 * the file is not a PE, has no icon, or none of its icons fits.
 */
export async function extractPeIcon(file: string, maxBytes: number): Promise<Buffer | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const bounded = new BoundedFile(handle, stat.size);

    const dos = await bounded.read(0, 64);
    if (!dos || dos.readUInt16LE(0) !== 0x5a4d) return null; // "MZ"
    const peOffset = dos.readUInt32LE(0x3c);
    const coff = await bounded.read(peOffset, 24);
    if (!coff || coff.readUInt32LE(0) !== 0x00004550) return null; // "PE\0\0"
    const sectionCount = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    if (sectionCount === 0 || sectionCount > MAX_SECTIONS) return null;

    const optional = await bounded.read(peOffset + 24, optionalSize);
    if (!optional || optional.length < 2) return null;
    const magic = optional.readUInt16LE(0);
    const directories = magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1;
    if (directories < 0 || optional.length < directories + 24) return null;
    const resourceRva = optional.readUInt32LE(directories + 16);
    const resourceSize = optional.readUInt32LE(directories + 20);
    if (resourceRva === 0 || resourceSize === 0) return null;

    const table = await bounded.read(peOffset + 24 + optionalSize, sectionCount * 40);
    if (!table) return null;
    const sections: Section[] = [];
    for (let i = 0; i < sectionCount; i++) {
      const at = i * 40;
      sections.push({
        virtualAddress: table.readUInt32LE(at + 12),
        span: Math.max(table.readUInt32LE(at + 8), table.readUInt32LE(at + 16)),
        rawPointer: table.readUInt32LE(at + 20),
      });
    }
    const base = rvaToOffset(sections, resourceRva);
    if (base === null) return null;
    const tree: ResourceTree = { file: bounded, base, size: resourceSize, sections };

    const group = await readResource(tree, RT_GROUP_ICON, null);
    if (!group) return null;
    for (const entry of parseIconGroup(group)) {
      const data = await readResource(tree, RT_ICON, entry.id);
      if (!data) continue;
      const png = data.subarray(0, 8).equals(PNG_SIGNATURE) ? data : dibToPng(data);
      if (png && png.length <= maxBytes) return Buffer.from(png);
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}
