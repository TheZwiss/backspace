import { describe, expect, it } from 'vitest';
import { isAnimatedImageFile, profileImageFileName } from './animatedImage';

function fileOf(name: string, type: string, bytes: number[] = [0]): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('isAnimatedImageFile', () => {
  it('treats a GIF MIME as animated', async () => {
    expect(await isAnimatedImageFile(fileOf('picture', 'image/gif'))).toBe(true);
  });

  it('treats a .gif name as animated when the MIME is missing', async () => {
    expect(await isAnimatedImageFile(fileOf('picture.GIF', ''))).toBe(true);
  });

  it('keeps a static PNG on the crop path', async () => {
    expect(await isAnimatedImageFile(fileOf('picture.png', 'image/png'))).toBe(false);
  });

  it('falls back to the static path for WebP when ImageDecoder is unavailable', async () => {
    const hadDecoder = 'ImageDecoder' in globalThis;
    const decoder = Reflect.get(globalThis, 'ImageDecoder');
    Reflect.deleteProperty(globalThis, 'ImageDecoder');
    try {
      expect(await isAnimatedImageFile(fileOf('picture.webp', 'image/webp'))).toBe(false);
    } finally {
      if (hadDecoder) Reflect.set(globalThis, 'ImageDecoder', decoder);
    }
  });
});

describe('profileImageFileName', () => {
  it('keeps the real extension so the server derives the right MIME type', () => {
    expect(profileImageFileName('avatar', fileOf('cat.gif', 'image/gif')))
      .toBe('avatar.gif');
    expect(profileImageFileName('banner', fileOf('wide.webp', 'image/webp')))
      .toBe('banner.webp');
    expect(profileImageFileName('avatar', fileOf('photo.jpeg', 'image/jpeg')))
      .toBe('avatar.jpg');
    expect(profileImageFileName('avatar', fileOf('cat.gif', 'image/png')))
      .toBe('avatar.png');
  });

  it('falls back to png when neither MIME nor name carries a known extension', () => {
    expect(profileImageFileName('avatar', fileOf('picture', ''))).toBe('avatar.png');
  });
});
