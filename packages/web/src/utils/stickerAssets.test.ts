import { afterEach, describe, expect, it, vi } from 'vitest';
import { localizeLoopbackAssetUrl } from '@backspace/shared/src/stickers';
import { displayStickerPreviewUrl, displayStickerUrl } from './stickerAssets';

const ID = 'a'.repeat(64);
const PATH = `/api/stickers/assets/${ID}.webp`;

afterEach(() => vi.unstubAllGlobals());

describe('localizeLoopbackAssetUrl', () => {
  it('draws a loopback asset from the page origin', () => {
    expect(localizeLoopbackAssetUrl(`https://localhost:3000${PATH}`, 'https://chat.example.net'))
      .toBe(`https://chat.example.net${PATH}`);
    expect(localizeLoopbackAssetUrl(`http://127.0.0.1:3000${PATH}?preview=1`, 'https://chat.example.net'))
      .toBe(`https://chat.example.net${PATH}?preview=1`);
  });

  it('leaves a public asset URL alone', () => {
    const url = `https://orbit.example.org${PATH}`;
    expect(localizeLoopbackAssetUrl(url, 'https://chat.example.net')).toBe(url);
  });

  it('keeps the loopback URL when the page is itself on loopback', () => {
    const url = `https://localhost:3000${PATH}`;
    expect(localizeLoopbackAssetUrl(url, 'http://localhost:5173')).toBe(url);
  });

  it('returns unparseable input unchanged', () => {
    expect(localizeLoopbackAssetUrl('not a url', 'https://chat.example.net')).toBe('not a url');
  });
});

describe('displayStickerUrl', () => {
  it('rewrites a loopback token for display and keeps the preview flag', () => {
    vi.stubGlobal('window', { location: { origin: 'https://chat.example.net' } });
    const token = `sticker:https://localhost:3000${PATH}`;
    expect(displayStickerUrl(token)).toBe(`https://chat.example.net${PATH}`);
    expect(displayStickerPreviewUrl(token)).toBe(`https://chat.example.net${PATH}?preview=1`);
  });

  it('is null for text that is not a sticker', () => {
    expect(displayStickerUrl('hello')).toBeNull();
  });
});
