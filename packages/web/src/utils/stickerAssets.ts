import {
  localizeLoopbackAssetUrl,
  stickerPreviewUrl,
  stickerUrl,
} from '@backspace/shared/src/stickers';

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/**
 * The URL to draw a sticker from. Same value as `stickerUrl`, except that an
 * asset a misconfigured instance minted on a loopback address (`localhost`,
 * `127.0.0.1`) is drawn from the instance serving this page, since the
 * loopback address cannot be reached from the viewer's machine.
 */
export function displayStickerUrl(value: string): string | null {
  const url = stickerUrl(value);
  return url ? localizeLoopbackAssetUrl(url, pageOrigin()) : null;
}

/** `displayStickerUrl` for the thumbnail (`?preview=1`) of a sticker token or asset URL. */
export function displayStickerPreviewUrl(value: string | null | undefined): string | null {
  const url = stickerPreviewUrl(value);
  return url ? localizeLoopbackAssetUrl(url, pageOrigin()) : null;
}
