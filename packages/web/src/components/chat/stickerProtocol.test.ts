import { describe, expect, it } from 'vitest';
import { stickerUrl, stickerPreviewUrl, resolveStickerPreviewUrl } from '@backspace/shared/src/stickers';

describe('sticker protocol', () => {
  const asset = `https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
  it('recognizes a dedicated token without changing emoji or ordinary text', () => {
    expect(stickerUrl(`sticker:${asset}`)).toBe(asset);
    for (const text of ['👍', asset, `hello sticker:${asset}`, `sticker:${asset} extra`]) {
      expect(stickerUrl(text)).toBeNull();
    }
  });
  it('rejects unsafe schemes, credentials, query strings and traversal', () => {
    for (const url of ['javascript:alert(1)', 'data:image/png;base64,abc', asset + '?x=1', asset + '#x',
      asset.replace('chat.test', 'user:pass@chat.test'), asset.replace('/assets/', '/x/../assets/')]) {
      expect(stickerUrl(`sticker:${url}`)).toBeNull();
    }
  });
  it('generates preview URLs correctly from token or asset URL', () => {
    expect(stickerPreviewUrl(`sticker:${asset}`)).toBe(`${asset}?preview=1`);
    expect(stickerPreviewUrl(asset)).toBe(`${asset}?preview=1`);
    expect(stickerPreviewUrl(null)).toBeNull();
    expect(stickerPreviewUrl('invalid')).toBeNull();

    expect(resolveStickerPreviewUrl(`sticker:${asset}`, 'https://local.test')).toBe(`https://local.test/api/stickers/assets/${'a'.repeat(64)}.webp?preview=1`);
  });
});
