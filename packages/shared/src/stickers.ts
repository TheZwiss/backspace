/** Namespaced values reuse message/reaction transport without colliding with native emoji. */
export const STICKER_PREFIX = 'sticker:';
export const MAX_STICKER_BYTES = 5 * 1024 * 1024;
export const STICKER_ID_PATTERN = /^[a-f0-9]{64}$/;

export interface PersonalSticker {
  id: string;
  name: string;
  token: string;
}

/**
 * Only canonical HTTP image endpoints are renderable, never markup or data URLs.
 * WHATWG URL is available in both supported Node and browser runtimes.
 */
export function stickerUrl(value: string): string | null {
  if (!value.startsWith(STICKER_PREFIX)) return null;
  const candidate = value.slice(STICKER_PREFIX.length);
  try {
    const url = new URL(candidate);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.search || url.hash || !/^\/api\/stickers\/assets\/[a-f0-9]{64}\.webp$/.test(url.pathname)) return null;
    return url.href === candidate ? candidate : null;
  } catch {
    return null;
  }
}
