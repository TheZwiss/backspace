import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { dibToPng, encodePng, extractPeIcon } from './peIcon';
import { buildPe, dib32 } from './peIcon.testSupport';

const MAX = 512 * 1024;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-icon-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, bytes: Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

/** Decode our own PNG output back to RGBA (filter 0 only, as encodePng writes it). */
function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('ascii');
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    raw.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, rgba };
}

const RED = [255, 0, 0, 255] as [number, number, number, number];
const CLEAR = [0, 0, 0, 0] as [number, number, number, number];

describe('dibToPng', () => {
  it('turns a 32-bit icon image into the same pixels, top-down, with its alpha', () => {
    const png = dibToPng(dib32(2, 2, (x, y) => (x === 0 && y === 0 ? RED : CLEAR)));
    expect(png).not.toBeNull();
    const { width, height, rgba } = decodePng(png as Buffer);
    expect([width, height]).toEqual([2, 2]);
    expect([...rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255]); // the top-left pixel stays top-left
    expect([...rgba.subarray(12, 16)]).toEqual([0, 0, 0, 0]);
  });

  it('refuses what is not an icon image', () => {
    expect(dibToPng(Buffer.alloc(10))).toBeNull();
    expect(dibToPng(Buffer.concat([Buffer.from([40, 0, 0, 0]), Buffer.alloc(36)]))).toBeNull(); // zero size
    const huge = dib32(2, 2, () => RED);
    huge.writeInt32LE(4096, 4);
    expect(dibToPng(huge)).toBeNull();
  });
});

describe('extractPeIcon', () => {
  const png = encodePng(1, 1, Buffer.from([1, 2, 3, 255]));

  it('returns a PNG frame as it is stored', async () => {
    const file = write('game.exe', buildPe([{ id: 1, data: png }], [{ width: 256, height: 256, bits: 32, id: 1 }]));
    expect((await extractPeIcon(file, MAX))?.equals(png)).toBe(true);
  });

  it('converts a DIB frame', async () => {
    const dib = dib32(2, 2, () => RED);
    const file = write('game.exe', buildPe([{ id: 7, data: dib }], [{ width: 2, height: 2, bits: 32, id: 7 }]));
    const result = await extractPeIcon(file, MAX);
    expect(result && decodePng(result).rgba.subarray(0, 4)).toEqual(Buffer.from([255, 0, 0, 255]));
  });

  it('takes the largest image of the group', async () => {
    const small = encodePng(1, 1, Buffer.from([9, 9, 9, 255]));
    const file = write('game.exe', buildPe(
      [{ id: 1, data: small }, { id: 2, data: png }],
      [{ width: 16, height: 16, bits: 32, id: 1 }, { width: 256, height: 256, bits: 32, id: 2 }],
    ));
    expect((await extractPeIcon(file, MAX))?.equals(png)).toBe(true);
  });

  it('falls back to a smaller image when the largest is over the limit', async () => {
    const big = Buffer.concat([encodePng(1, 1, Buffer.from([1, 1, 1, 255])), Buffer.alloc(2000)]);
    const small = encodePng(1, 1, Buffer.from([2, 2, 2, 255]));
    const file = write('game.exe', buildPe(
      [{ id: 1, data: big }, { id: 2, data: small }],
      [{ width: 256, height: 256, bits: 32, id: 1 }, { width: 32, height: 32, bits: 32, id: 2 }],
    ));
    expect((await extractPeIcon(file, 1000))?.equals(small)).toBe(true);
  });

  it('is null for an executable without an icon', async () => {
    expect(await extractPeIcon(write('none.exe', buildPe([], null)), MAX)).toBeNull();
  });

  it('is null for files that are not, or no longer, a PE', async () => {
    expect(await extractPeIcon(write('text.exe', Buffer.from('MZ but nothing else')), MAX)).toBeNull();
    expect(await extractPeIcon(write('empty.exe', Buffer.alloc(0)), MAX)).toBeNull();
    expect(await extractPeIcon(path.join(dir, 'missing.exe'), MAX)).toBeNull();
    expect(await extractPeIcon(dir, MAX)).toBeNull();
    const valid = buildPe([{ id: 1, data: png }], [{ width: 1, height: 1, bits: 32, id: 1 }]);
    expect(await extractPeIcon(write('cut.exe', valid.subarray(0, valid.length - 30)), MAX)).toBeNull();
  });

  it('survives corrupted tables instead of reading wild offsets or looping', async () => {
    const valid = buildPe([{ id: 1, data: png }], [{ width: 1, height: 1, bits: 32, id: 1 }]);
    for (let seed = 0; seed < 200; seed++) {
      const copy = Buffer.from(valid);
      // Deterministic damage to the header and the resource tree
      for (let k = 0; k < 6; k++) {
        const at = (seed * 31 + k * 97) % 0x340;
        copy[at] = (copy[at] as number) ^ (0xff - ((seed + k) % 200));
      }
      await expect(extractPeIcon(write('fuzz.exe', copy), MAX)).resolves.not.toThrow();
    }
  });
});
