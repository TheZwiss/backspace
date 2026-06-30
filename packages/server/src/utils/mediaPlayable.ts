/**
 * Web-playability classification for video attachments.
 *
 * The browser `<video>` element can only decode a subset of the formats users
 * upload. The dominant failure case is a macOS screen recording — a
 * `video/quicktime` (.mov) container holding an HEVC (H.265) stream — which
 * Chromium, Firefox and stock Electron cannot decode. The file uploads fine,
 * a server-side ffmpeg poster is generated, but inline playback silently fails
 * (stuck at 0:00 with no error). We persist this classification per attachment
 * so the client can render a download fallback instead of a dead player.
 *
 * The result is a deliberate tri-state:
 *   - `false` — confidently undecodable in mainstream browsers (e.g. HEVC).
 *               The client renders the fallback card directly, no flash.
 *   - `true`  — confidently decodable (web codec in a web container).
 *   - `null`  — unknown / optimistic. The codec couldn't be probed (ffmpeg
 *               absent or probe failed), or it's a web-safe codec in a
 *               container with inconsistent cross-browser support (e.g. H.264
 *               in .mov). The client attempts playback and degrades to the
 *               fallback via the `<video>` `onError` handler.
 *
 * We never widen `false` beyond codecs we are certain fail everywhere, so an
 * instance without ffmpeg (codec always undefined) keeps today's behaviour
 * (attempt playback) rather than regressing every video to "unplayable".
 */

/** ffprobe `codec_name` (or mp4/mov box tag) values that no mainstream browser decodes. */
const UNPLAYABLE_VIDEO_CODECS = new Set([
  // HEVC / H.265 — codec_name is `hevc`; box tags are `hvc1` / `hev1`.
  'hevc', 'hvc1', 'hev1', 'h265',
  // Apple ProRes — editing/intermediate codec, never web-decodable.
  'prores',
  // Windows Media Video.
  'wmv1', 'wmv2', 'wmv3', 'vc1',
  // Legacy / capture codecs.
  'mpeg1video', 'mpeg2video', 'dnxhd', 'mjpeg', 'vp6', 'vp6f',
]);

/** Codecs every modern browser can decode when in a web-standard container. */
const PLAYABLE_VIDEO_CODECS = new Set([
  'h264', 'avc1', // H.264 / AVC
  'vp8', 'vp9',
  'av1', 'av01',
  'theora',
]);

/** Containers with reliable cross-browser `<video>` support. */
const PLAYABLE_VIDEO_CONTAINERS = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
]);

/**
 * Classify whether a video attachment can be played inline in a browser
 * `<video>` element, given its container mimetype and the probed video codec.
 *
 * @param mimetype Container mimetype (e.g. `video/quicktime`).
 * @param codec    ffprobe `codec_name` of the primary video stream, if known.
 * @returns `false` (known-unplayable), `true` (known-playable) or `null` (unknown/optimistic).
 */
export function classifyVideoPlayable(
  mimetype: string,
  codec: string | null | undefined,
): boolean | null {
  if (!mimetype.startsWith('video/')) return null;
  if (!codec) return null;

  const c = codec.toLowerCase();
  if (UNPLAYABLE_VIDEO_CODECS.has(c)) return false;
  if (PLAYABLE_VIDEO_CONTAINERS.has(mimetype) && PLAYABLE_VIDEO_CODECS.has(c)) return true;

  // Web-safe codec in a shaky container (H.264 in .mov), or an unrecognised
  // codec we can't vouch for: stay optimistic and let the client's onError
  // handler catch a genuine playback failure.
  return null;
}
