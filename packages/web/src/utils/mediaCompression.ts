/**
 * Compression of photos and videos on the sender's device, before they are
 * uploaded. A message's attachments are the biggest thing a member sends and
 * the biggest thing an instance stores, so the default is to shrink them here
 * and keep the originals for when the sender picks "document" (see
 * `MessageInput`, `uploads.md` §9, "Compression and documents").
 *
 * Everything here answers "send this file instead" or "send it as it is" by
 * returning null: a file this module cannot improve, does not understand, or
 * that came out no smaller is never replaced. A failure is never an upload
 * error, only the original going up.
 */

/** Photos smaller than this are sent untouched: the saving would not pay for a re-encode. */
export const IMAGE_COMPRESS_MIN_BYTES = 350 * 1024;
/** Longest side, in pixels, a compressed photo keeps. */
export const IMAGE_MAX_DIMENSION = 2560;
/** Encoder quality of a compressed photo (0..1). */
export const IMAGE_QUALITY = 0.85;
/** A re-encoded photo or video must be at least this much smaller than the original to replace it. */
export const MIN_SAVING_RATIO = 0.9;
/** Videos smaller than this are sent untouched. */
export const VIDEO_COMPRESS_MIN_BYTES = 8 * 1024 * 1024;
/** Videos larger than this are not compressed here: the result is built in memory. */
export const VIDEO_COMPRESS_MAX_BYTES = 400 * 1024 * 1024;
/** Tallest picture a compressed video keeps. */
export const VIDEO_MAX_HEIGHT = 720;
/** A video already below this bitrate (bits per second) has nothing left to gain. */
export const VIDEO_ALREADY_SMALL_BPS = 2_000_000;

// ─── Photos ────────────────────────────────────────────────────────────────

const COMPRESSIBLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp']);

/** True when the leading bytes of a WebP file declare an animation (VP8X flag bit 1). */
export function isAnimatedWebp(head: Uint8Array): boolean {
  if (head.length < 21) return false;
  const tag = (offset: number): string => String.fromCharCode(head[offset]!, head[offset + 1]!, head[offset + 2]!, head[offset + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || tag(12) !== 'VP8X') return false;
  return (head[20]! & 0x02) !== 0;
}

/** True when a PNG carries an `acTL` chunk, which only an animated PNG has (it precedes the image data). */
export function isAnimatedPng(head: Uint8Array): boolean {
  for (let i = 0; i + 4 <= head.length; i++) {
    if (head[i] === 0x61 && head[i + 1] === 0x63 && head[i + 2] === 0x54 && head[i + 3] === 0x4c) return true;
    // Image data begins here: no animation control chunk can follow
    if (head[i] === 0x49 && head[i + 1] === 0x44 && head[i + 2] === 0x41 && head[i + 3] === 0x54) return false;
  }
  return false;
}

export function isCompressibleImageType(type: string): boolean {
  return COMPRESSIBLE_IMAGE_TYPES.has(type.toLowerCase());
}

export interface ImageTarget {
  width: number;
  height: number;
  /** MIME type to encode as. */
  type: 'image/jpeg' | 'image/webp';
  extension: 'jpg' | 'webp';
}

/**
 * The size and format a photo is re-encoded to, or null when it should go up as
 * it is. JPEG stays JPEG (a photo); PNG, BMP and WebP become WebP, which keeps
 * transparency and is far smaller for screenshots.
 */
export function planImageCompression(
  input: { type: string; size: number; width: number; height: number },
  maxDimension: number = IMAGE_MAX_DIMENSION,
): ImageTarget | null {
  if (!isCompressibleImageType(input.type)) return null;
  if (input.size < IMAGE_COMPRESS_MIN_BYTES) return null;
  if (!(input.width > 0) || !(input.height > 0)) return null;
  const longest = Math.max(input.width, input.height);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  const width = Math.max(1, Math.round(input.width * scale));
  const height = Math.max(1, Math.round(input.height * scale));
  return input.type.toLowerCase() === 'image/jpeg'
    ? { width, height, type: 'image/jpeg', extension: 'jpg' }
    : { width, height, type: 'image/webp', extension: 'webp' };
}

/** `photo.PNG` -> `photo.webp`. A name with no extension just gains one. */
export function renamedWithExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base || 'file'}.${extension}`;
}

/** The browser-side pieces of photo compression, replaceable in tests. */
export interface ImageCodec {
  /** Decode with the EXIF orientation applied; null when the browser cannot read the file. */
  decode(file: Blob): Promise<{ width: number; height: number; release(): void; draw(width: number, height: number): Promise<Blob | null> } | null>;
}

export interface CompressImageDeps {
  codec: ImageCodec;
  readHead: (file: Blob) => Promise<Uint8Array>;
}

async function readHeadBytes(file: Blob, length = 65536): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, length).arrayBuffer());
}

/**
 * Re-encode a photo: longest side capped, quality 0.85, EXIF (including GPS
 * position) dropped as a side effect of drawing it on a canvas. Null when the
 * original should be sent.
 */
export async function compressImage(
  file: File,
  deps: CompressImageDeps = { codec: browserImageCodec, readHead: readHeadBytes },
): Promise<File | null> {
  if (!isCompressibleImageType(file.type) || file.size < IMAGE_COMPRESS_MIN_BYTES) return null;
  try {
    const head = await deps.readHead(file);
    if (file.type === 'image/webp' && isAnimatedWebp(head)) return null;
    if (file.type === 'image/png' && isAnimatedPng(head)) return null;

    const decoded = await deps.codec.decode(file);
    if (!decoded) return null;
    try {
      const plan = planImageCompression({ type: file.type, size: file.size, width: decoded.width, height: decoded.height });
      if (!plan) return null;
      const blob = await decoded.draw(plan.width, plan.height);
      if (!blob || blob.type !== plan.type) return null;
      if (blob.size >= file.size * MIN_SAVING_RATIO) return null;
      return new File([blob], renamedWithExtension(file.name, plan.extension), { type: plan.type, lastModified: file.lastModified });
    } finally {
      decoded.release();
    }
  } catch {
    return null;
  }
}

/** The real thing: `createImageBitmap` for decoding and a canvas for encoding. */
export const browserImageCodec: ImageCodec = {
  async decode(file) {
    if (typeof createImageBitmap !== 'function') return null;
    let bitmap: ImageBitmap;
    try {
      // The EXIF orientation is applied by default, so the pixels come out upright
      bitmap = await createImageBitmap(file);
    } catch {
      return null;
    }
    return {
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
      draw: (width, height) => drawAndEncode(bitmap, width, height, file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp'),
    };
  },
};

function drawAndEncode(bitmap: ImageBitmap, width: number, height: number, type: 'image/jpeg' | 'image/webp'): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    if (type === 'image/jpeg') {
      // JPEG has no alpha: a transparent source would otherwise turn black
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type, quality: IMAGE_QUALITY }).catch(() => null);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, IMAGE_QUALITY));
}

// ─── Videos ────────────────────────────────────────────────────────────────

export interface VideoPlan {
  container: 'mp4' | 'webm';
  videoCodec: 'avc' | 'vp9';
  audioCodec: 'aac' | 'opus';
  /** Output picture height; the width follows the aspect ratio. */
  height: number;
  extension: 'mp4' | 'webm';
  mimeType: 'video/mp4' | 'video/webm';
}

/**
 * How a video is re-encoded, or null to send it as it is. H.264 + AAC in MP4
 * when the browser can encode them (plays everywhere); otherwise VP9 + Opus in
 * WebM (every current browser plays it). The picture is capped at 720p, kept
 * at the source's size when it is already smaller.
 */
export function planVideoCompression(input: {
  size: number;
  durationSeconds: number;
  height: number;
  canAvc: boolean;
  canAac: boolean;
  canVp9: boolean;
  canOpus: boolean;
}): VideoPlan | null {
  if (input.size < VIDEO_COMPRESS_MIN_BYTES || input.size > VIDEO_COMPRESS_MAX_BYTES) return null;
  if (!(input.height > 0)) return null;
  if (input.durationSeconds > 0 && (input.size * 8) / input.durationSeconds < VIDEO_ALREADY_SMALL_BPS) return null;
  // Even heights only: most encoders refuse odd frame sizes
  const height = Math.max(2, Math.floor(Math.min(input.height, VIDEO_MAX_HEIGHT) / 2) * 2);
  if (input.canAvc && input.canAac) {
    return { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', height, extension: 'mp4', mimeType: 'video/mp4' };
  }
  if (input.canVp9 && input.canOpus) {
    return { container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', height, extension: 'webm', mimeType: 'video/webm' };
  }
  return null;
}

export interface CompressVideoOptions {
  /** 0..1, called as the encode advances. */
  onProgress?: (fraction: number) => void;
  /** Aborting stops the encode and resolves null, so the original is sent. */
  signal?: AbortSignal;
}

/** WebCodecs is what makes this faster than playing the video back; without it the original is sent. */
export function canCompressVideo(): boolean {
  return typeof VideoEncoder === 'function' && typeof VideoDecoder === 'function';
}

/**
 * Re-encode a video with WebCodecs (Mediabunny). The library is loaded on first
 * use, so a member who never sends a video never downloads it. Null when the
 * original should be sent: not a video, too small or too large, already
 * lightweight, no encoder, cancelled, or no smaller than the original.
 */
export async function compressVideo(file: File, options: CompressVideoOptions = {}): Promise<File | null> {
  if (!file.type.startsWith('video/') || !canCompressVideo()) return null;
  if (file.size < VIDEO_COMPRESS_MIN_BYTES || file.size > VIDEO_COMPRESS_MAX_BYTES) return null;
  if (options.signal?.aborted) return null;

  let conversion: { cancel(): Promise<void> } | null = null;
  const onAbort = (): void => { void conversion?.cancel().catch(() => {}); };
  try {
    const mb = await import('mediabunny');
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return null;
    const durationSeconds = await input.computeDuration();

    const [canAvc, canAac, canVp9, canOpus] = await Promise.all([
      mb.canEncodeVideo('avc'),
      mb.canEncodeAudio('aac'),
      mb.canEncodeVideo('vp9'),
      mb.canEncodeAudio('opus'),
    ]);
    const plan = planVideoCompression({
      size: file.size,
      durationSeconds,
      height: videoTrack.displayHeight,
      canAvc, canAac, canVp9, canOpus,
    });
    if (!plan) return null;

    const target = new mb.BufferTarget();
    const output = new mb.Output({
      format: plan.container === 'mp4' ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat(),
      target,
    });
    const converting = await mb.Conversion.init({
      input,
      output,
      video: { height: plan.height, codec: plan.videoCodec, quality: mb.QUALITY_MEDIUM },
      audio: { codec: plan.audioCodec, quality: mb.QUALITY_MEDIUM },
    });
    if (!converting.isValid) return null;
    conversion = converting;
    converting.onProgress = (fraction: number) => options.onProgress?.(fraction);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) return null;

    await converting.execute();
    if (options.signal?.aborted) return null;

    const buffer = target.buffer;
    if (!buffer || buffer.byteLength === 0 || buffer.byteLength >= file.size * MIN_SAVING_RATIO) return null;
    return new File([buffer], renamedWithExtension(file.name, plan.extension), { type: plan.mimeType, lastModified: file.lastModified });
  } catch {
    return null;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

// ─── One entry point ───────────────────────────────────────────────────────

/**
 * Whether compressing this file is worth starting: a photo or video of a size
 * the encoders would improve. Anything else goes straight to the upload, with no
 * progress tile and no wait.
 */
export function shouldTryCompression(file: Pick<File, 'type' | 'size'>): boolean {
  if (isCompressibleImageType(file.type)) return file.size >= IMAGE_COMPRESS_MIN_BYTES;
  if (file.type.startsWith('video/')) {
    return canCompressVideo() && file.size >= VIDEO_COMPRESS_MIN_BYTES && file.size <= VIDEO_COMPRESS_MAX_BYTES;
  }
  return false;
}

/** What kind of file `prepareForUpload` can shrink. */
export function compressionKind(file: Pick<File, 'type'>): 'image' | 'video' | null {
  if (isCompressibleImageType(file.type)) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return null;
}

/**
 * The file to upload for a chosen one. Documents (original files) and anything
 * this module cannot improve come back as they are.
 */
export async function prepareForUpload(
  file: File,
  mode: 'compress' | 'original',
  options: CompressVideoOptions = {},
): Promise<{ file: File; compressed: boolean }> {
  if (mode === 'original') return { file, compressed: false };
  const kind = compressionKind(file);
  const replacement = kind === 'image' ? await compressImage(file) : kind === 'video' ? await compressVideo(file, options) : null;
  return replacement ? { file: replacement, compressed: true } : { file, compressed: false };
}
