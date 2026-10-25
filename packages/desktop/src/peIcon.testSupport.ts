/**
 * A minimal but spec-shaped PE32+ file whose only content is an icon
 * resource: DOS header, PE and COFF headers, an optional header with the
 * resource data directory, one `.rsrc` section holding the RT_ICON /
 * RT_GROUP_ICON tree. Tests build executables with it instead of shipping
 * binaries.
 */

export interface PeIconImage {
  id: number;
  data: Buffer;
}

export interface PeGroupEntry {
  width: number;
  height: number;
  bits: number;
  id: number;
}

const SECTION_RVA = 0x1000;
const SECTION_RAW = 0x200;

function dir(entries: Array<{ id: number; target: number; subdir: boolean }>): Buffer {
  const buffer = Buffer.alloc(16 + entries.length * 8);
  buffer.writeUInt16LE(entries.length, 14); // id entries
  entries.forEach((entry, i) => {
    buffer.writeUInt32LE(entry.id, 16 + i * 8);
    buffer.writeUInt32LE(((entry.subdir ? 0x80000000 : 0) | entry.target) >>> 0, 16 + i * 8 + 4);
  });
  return buffer;
}

function groupResource(entries: PeGroupEntry[]): Buffer {
  const buffer = Buffer.alloc(6 + entries.length * 14);
  buffer.writeUInt16LE(1, 2); // type: icon
  buffer.writeUInt16LE(entries.length, 4);
  entries.forEach((entry, i) => {
    const at = 6 + i * 14;
    buffer[at] = entry.width >= 256 ? 0 : entry.width;
    buffer[at + 1] = entry.height >= 256 ? 0 : entry.height;
    buffer.writeUInt16LE(1, at + 4); // planes
    buffer.writeUInt16LE(entry.bits, at + 6);
    buffer.writeUInt16LE(entry.id, at + 12);
  });
  return buffer;
}

/** Build the file. `group` null leaves the executable without an icon group. */
export function buildPe(images: PeIconImage[], group: PeGroupEntry[] | null): Buffer {
  const groupData = group ? groupResource(group) : null;

  // Directory tables first, then data entries, then the blobs
  const withGroup = groupData !== null;
  const rootSize = 16 + (withGroup ? 2 : 1) * 8;
  const iconTypeSize = 16 + images.length * 8;
  const langSize = 16 + 8;
  let cursor = rootSize;
  const iconTypeAt = cursor; cursor += iconTypeSize;
  const iconLangAt = images.map(() => { const at = cursor; cursor += langSize; return at; });
  const groupNameAt = withGroup ? cursor : 0; if (withGroup) cursor += langSize;
  const groupLangAt = withGroup ? cursor : 0; if (withGroup) cursor += langSize;
  const dataEntryCount = images.length + (withGroup ? 1 : 0);
  const dataEntriesAt = cursor; cursor += dataEntryCount * 16;

  const blobs: Buffer[] = [...images.map((image) => image.data), ...(groupData ? [groupData] : [])];
  const blobAt: number[] = [];
  for (const blob of blobs) {
    cursor = Math.ceil(cursor / 4) * 4;
    blobAt.push(cursor);
    cursor += blob.length;
  }
  const sectionSize = cursor;

  const section = Buffer.alloc(sectionSize);
  const rootEntries = [{ id: 3, target: iconTypeAt, subdir: true }];
  if (withGroup) rootEntries.push({ id: 14, target: groupNameAt, subdir: true });
  dir(rootEntries).copy(section, 0);
  dir(images.map((image, i) => ({ id: image.id, target: iconLangAt[i] as number, subdir: true }))).copy(section, iconTypeAt);
  images.forEach((_, i) => {
    dir([{ id: 0x409, target: dataEntriesAt + i * 16, subdir: false }]).copy(section, iconLangAt[i] as number);
  });
  if (withGroup) {
    dir([{ id: 1, target: groupLangAt, subdir: true }]).copy(section, groupNameAt);
    dir([{ id: 0x409, target: dataEntriesAt + images.length * 16, subdir: false }]).copy(section, groupLangAt);
  }
  blobs.forEach((blob, i) => {
    const entryAt = dataEntriesAt + i * 16;
    section.writeUInt32LE(SECTION_RVA + (blobAt[i] as number), entryAt);
    section.writeUInt32LE(blob.length, entryAt + 4);
    blob.copy(section, blobAt[i] as number);
  });

  const optionalSize = 240;
  const headers = Buffer.alloc(SECTION_RAW);
  headers.writeUInt16LE(0x5a4d, 0); // "MZ"
  headers.writeUInt32LE(0x40, 0x3c);
  headers.writeUInt32LE(0x00004550, 0x40); // "PE\0\0"
  headers.writeUInt16LE(0x8664, 0x44); // machine
  headers.writeUInt16LE(1, 0x46); // one section
  headers.writeUInt16LE(optionalSize, 0x54);
  const optional = 0x58;
  headers.writeUInt16LE(0x20b, optional); // PE32+
  headers.writeUInt32LE(SECTION_RVA, optional + 112 + 16); // resource directory RVA
  headers.writeUInt32LE(sectionSize, optional + 112 + 20);
  const sectionHeader = optional + optionalSize;
  headers.write('.rsrc', sectionHeader, 'ascii');
  headers.writeUInt32LE(sectionSize, sectionHeader + 8); // virtual size
  headers.writeUInt32LE(SECTION_RVA, sectionHeader + 12);
  headers.writeUInt32LE(sectionSize, sectionHeader + 16); // raw size
  headers.writeUInt32LE(SECTION_RAW, sectionHeader + 20);

  return Buffer.concat([headers, section]);
}

/** A DIB icon image: BITMAPINFOHEADER, bottom-up 32-bit BGRA pixels, 1-bit AND mask. */
export function dib32(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const at = ((height - 1 - y) * width + x) * 4;
      pixels[at] = b; pixels[at + 1] = g; pixels[at + 2] = r; pixels[at + 3] = a;
    }
  }
  const maskRow = Math.ceil(width / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * height)]);
}
