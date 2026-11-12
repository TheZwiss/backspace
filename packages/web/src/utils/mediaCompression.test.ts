import { describe, expect, it } from 'vitest';
import {
  IMAGE_COMPRESS_MIN_BYTES,
  IMAGE_MAX_DIMENSION,
  VIDEO_COMPRESS_MAX_BYTES,
  VIDEO_COMPRESS_MIN_BYTES,
  compressImage,
  compressionKind,
  isAnimatedPng,
  isAnimatedWebp,
  planImageCompression,
  planVideoCompression,
  prepareForUpload,
  shouldTryCompression,
  renamedWithExtension,
  type CompressImageDeps,
} from './mediaCompression';

const KB = 1024;
const MB = 1024 * KB;

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function webpHead(flags: number): Uint8Array {
  return bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, flags, 0, 0, 0);
}

function fileOf(size: number, type: string, name = 'photo.jpg'): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 1_700_000_000_000 });
}

describe('animation detection', () => {
  it('sees the animation flag of a WebP', () => {
    expect(isAnimatedWebp(webpHead(0x02))).toBe(true);
    expect(isAnimatedWebp(webpHead(0x10))).toBe(false);
  });

  it('treats a short or foreign buffer as not animated', () => {
    expect(isAnimatedWebp(bytes(1, 2, 3))).toBe(false);
    expect(isAnimatedWebp(new Uint8Array(40))).toBe(false);
  });

  it('sees an acTL chunk before the image data of a PNG', () => {
    const animated = bytes(0x89, ...ascii('PNG'), 0, 0, 0, 8, ...ascii('acTL'), 0, 0, 0, 2, ...ascii('IDAT'));
    const still = bytes(0x89, ...ascii('PNG'), 0, 0, 0, 8, ...ascii('IHDR'), 0, 0, 0, 2, ...ascii('IDAT'), ...ascii('acTL'));
    expect(isAnimatedPng(animated)).toBe(true);
    // An acTL-looking sequence inside the pixel data does not count
    expect(isAnimatedPng(still)).toBe(false);
  });
});

describe('planImageCompression', () => {
  const big = IMAGE_COMPRESS_MIN_BYTES + 1;

  it('keeps a JPEG a JPEG and turns PNG, BMP and WebP into WebP', () => {
    expect(planImageCompression({ type: 'image/jpeg', size: big, width: 1000, height: 800 })).toMatchObject({ type: 'image/jpeg', extension: 'jpg' });
    for (const type of ['image/png', 'image/bmp', 'image/webp']) {
      expect(planImageCompression({ type, size: big, width: 1000, height: 800 })).toMatchObject({ type: 'image/webp', extension: 'webp' });
    }
  });

  it('caps the longest side and keeps the aspect ratio', () => {
    expect(planImageCompression({ type: 'image/jpeg', size: big, width: 5120, height: 2880 })).toMatchObject({ width: IMAGE_MAX_DIMENSION, height: 1440 });
    expect(planImageCompression({ type: 'image/jpeg', size: big, width: 2880, height: 5120 })).toMatchObject({ width: 1440, height: IMAGE_MAX_DIMENSION });
  });

  it('never enlarges a smaller picture', () => {
    expect(planImageCompression({ type: 'image/png', size: big, width: 800, height: 600 })).toMatchObject({ width: 800, height: 600 });
  });

  it('leaves small files, GIFs, SVGs and unreadable sizes alone', () => {
    expect(planImageCompression({ type: 'image/jpeg', size: IMAGE_COMPRESS_MIN_BYTES - 1, width: 4000, height: 3000 })).toBeNull();
    expect(planImageCompression({ type: 'image/gif', size: big, width: 400, height: 300 })).toBeNull();
    expect(planImageCompression({ type: 'image/svg+xml', size: big, width: 400, height: 300 })).toBeNull();
    expect(planImageCompression({ type: 'image/jpeg', size: big, width: 0, height: 300 })).toBeNull();
  });
});

describe('renamedWithExtension', () => {
  it('swaps or adds the extension', () => {
    expect(renamedWithExtension('IMG_001.PNG', 'webp')).toBe('IMG_001.webp');
    expect(renamedWithExtension('archive.tar.gz', 'webp')).toBe('archive.tar.webp');
    expect(renamedWithExtension('noext', 'jpg')).toBe('noext.jpg');
    expect(renamedWithExtension('.hidden', 'jpg')).toBe('.hidden.jpg');
  });
});

describe('compressImage', () => {
  const noHead = async (): Promise<Uint8Array> => new Uint8Array(0);

  function codecReturning(blobSize: number, type: string, size = { width: 4000, height: 3000 }): CompressImageDeps & { released: () => boolean; drawn: () => { width: number; height: number } | null } {
    let released = false;
    let drawn: { width: number; height: number } | null = null;
    return {
      readHead: noHead,
      codec: {
        async decode() {
          return {
            ...size,
            release: () => { released = true; },
            draw: async (width, height) => { drawn = { width, height }; return new Blob([new Uint8Array(blobSize)], { type }); },
          };
        },
      },
      released: () => released,
      drawn: () => drawn,
    };
  }

  it('returns the smaller re-encoded file, renamed, and releases the decoded image', async () => {
    const deps = codecReturning(400 * KB, 'image/webp');
    const out = await compressImage(fileOf(3 * MB, 'image/png', 'shot.png'), deps);
    expect(out).not.toBeNull();
    expect(out!.name).toBe('shot.webp');
    expect(out!.type).toBe('image/webp');
    expect(out!.size).toBe(400 * KB);
    expect(deps.drawn()).toEqual({ width: IMAGE_MAX_DIMENSION, height: 1920 });
    expect(deps.released()).toBe(true);
  });

  it('keeps the original when the result is not clearly smaller', async () => {
    const deps = codecReturning(Math.round(2.9 * MB), 'image/jpeg');
    expect(await compressImage(fileOf(3 * MB, 'image/jpeg'), deps)).toBeNull();
    expect(deps.released()).toBe(true);
  });

  it('keeps the original when the browser could not encode the planned type', async () => {
    const deps = codecReturning(100 * KB, 'image/png');
    expect(await compressImage(fileOf(3 * MB, 'image/png'), deps)).toBeNull();
  });

  it('keeps the original when the browser cannot decode it', async () => {
    const deps: CompressImageDeps = { readHead: noHead, codec: { decode: async () => null } };
    expect(await compressImage(fileOf(3 * MB, 'image/jpeg'), deps)).toBeNull();
  });

  it('never flattens an animated WebP or PNG', async () => {
    const animatedWebp: CompressImageDeps = { ...codecReturning(10, 'image/webp'), readHead: async () => webpHead(0x02) };
    expect(await compressImage(fileOf(3 * MB, 'image/webp', 'a.webp'), animatedWebp)).toBeNull();
    const apng: CompressImageDeps = {
      ...codecReturning(10, 'image/webp'),
      readHead: async () => bytes(0x89, ...ascii('PNG'), 0, 0, 0, 8, ...ascii('acTL')),
    };
    expect(await compressImage(fileOf(3 * MB, 'image/png', 'a.png'), apng)).toBeNull();
  });

  it('swallows an error from the codec', async () => {
    const deps: CompressImageDeps = { readHead: noHead, codec: { decode: async () => { throw new Error('boom'); } } };
    expect(await compressImage(fileOf(3 * MB, 'image/jpeg'), deps)).toBeNull();
  });

  it('skips files below the size floor without decoding', async () => {
    const deps = codecReturning(1, 'image/jpeg');
    expect(await compressImage(fileOf(IMAGE_COMPRESS_MIN_BYTES - 1, 'image/jpeg'), deps)).toBeNull();
    expect(deps.drawn()).toBeNull();
  });
});

describe('planVideoCompression', () => {
  const base = { size: 60 * MB, durationSeconds: 60, height: 1080, canAvc: true, canAac: true, canVp9: true, canOpus: true };

  it('prefers H.264 + AAC in MP4 and caps the picture at 720p', () => {
    expect(planVideoCompression(base)).toEqual({
      container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', height: 720, extension: 'mp4', mimeType: 'video/mp4',
    });
  });

  it('falls back to VP9 + Opus in WebM when H.264 cannot be encoded', () => {
    expect(planVideoCompression({ ...base, canAvc: false })).toMatchObject({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', extension: 'webm', mimeType: 'video/webm' });
    expect(planVideoCompression({ ...base, canAac: false })).toMatchObject({ container: 'webm' });
  });

  it('gives up when no usable encoder exists', () => {
    expect(planVideoCompression({ ...base, canAvc: false, canVp9: false })).toBeNull();
  });

  it('keeps a smaller picture at its own height, rounded down to an even number', () => {
    expect(planVideoCompression({ ...base, height: 480 })?.height).toBe(480);
    expect(planVideoCompression({ ...base, height: 541 })?.height).toBe(540);
  });

  it('leaves small, huge and already lightweight videos alone', () => {
    expect(planVideoCompression({ ...base, size: VIDEO_COMPRESS_MIN_BYTES - 1 })).toBeNull();
    expect(planVideoCompression({ ...base, size: VIDEO_COMPRESS_MAX_BYTES + 1 })).toBeNull();
    // 20 MB over 300 s is about 0.5 Mbit/s: nothing left to gain
    expect(planVideoCompression({ ...base, size: 20 * MB, durationSeconds: 300 })).toBeNull();
    expect(planVideoCompression({ ...base, height: 0 })).toBeNull();
  });
});

describe('shouldTryCompression', () => {
  it('starts only for photos big enough to gain from it', () => {
    expect(shouldTryCompression({ type: 'image/jpeg', size: IMAGE_COMPRESS_MIN_BYTES })).toBe(true);
    expect(shouldTryCompression({ type: 'image/jpeg', size: IMAGE_COMPRESS_MIN_BYTES - 1 })).toBe(false);
    expect(shouldTryCompression({ type: 'image/gif', size: 50 * MB })).toBe(false);
  });

  it('never starts for videos where WebCodecs is missing (jsdom) and never for other files', () => {
    expect(shouldTryCompression({ type: 'video/mp4', size: VIDEO_COMPRESS_MIN_BYTES })).toBe(false);
    expect(shouldTryCompression({ type: 'application/pdf', size: 50 * MB })).toBe(false);
  });
});

describe('prepareForUpload', () => {
  it('sends the original untouched as a document', async () => {
    const file = fileOf(5 * MB, 'image/jpeg');
    const out = await prepareForUpload(file, 'original');
    expect(out).toEqual({ file, compressed: false });
    expect(out.file).toBe(file);
  });

  it('sends files it cannot shrink as they are', async () => {
    const pdf = fileOf(5 * MB, 'application/pdf', 'doc.pdf');
    expect((await prepareForUpload(pdf, 'compress')).file).toBe(pdf);
    expect((await prepareForUpload(pdf, 'compress')).compressed).toBe(false);
  });

  it('classifies what it can shrink', () => {
    expect(compressionKind({ type: 'image/png' })).toBe('image');
    expect(compressionKind({ type: 'video/quicktime' })).toBe('video');
    expect(compressionKind({ type: 'audio/mpeg' })).toBeNull();
    expect(compressionKind({ type: '' })).toBeNull();
  });
});
