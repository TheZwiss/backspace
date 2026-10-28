/**
 * Animated-image detection for profile uploads.
 *
 * The profile pipeline crops static pictures in the browser before uploading
 * (`ImageCropModal` → `cropImage`, which paints one frame into a canvas). An
 * animated GIF must not take that path: the canvas keeps a single frame, so
 * the animation is flattened even though the server preserves it. Files this
 * module reports as animated are uploaded as-is and framed with CSS
 * (`object-cover` / `background-size: cover`) instead of being cropped.
 */

/** Which profile surface the file will feed; only used to build the filename. */
export type ProfileImageKind = 'avatar' | 'banner';

interface ImageDecoderTrackLike {
  frameCount: number;
}

interface ImageDecoderLike {
  tracks: {
    ready: Promise<void>;
    selectedTrack: ImageDecoderTrackLike | null;
  };
}

type ImageDecoderConstructor = new (init: {
  data: ArrayBuffer;
  type: string;
}) => ImageDecoderLike;

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/png': 'png',
  'image/apng': 'png',
  'image/jpeg': 'jpg',
  'image/avif': 'avif',
};

/** Extension of a file name, lowercased, without the dot. */
function nameExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Whether `file` carries more than one frame.
 *
 * GIF is answered from the MIME/extension alone — the browser renders it as an
 * animation regardless of what the `ImageDecoder` API supports. WebP and APNG
 * are inspected with `ImageDecoder` when the platform has it; without that API
 * the file takes the static path, which is the safe fallback (a single-frame
 * crop), never a silent re-encode of the animation.
 */
export async function isAnimatedImageFile(file: File): Promise<boolean> {
  const mime = file.type.toLowerCase();
  const namedExtension = nameExtension(file.name);
  if (mime === 'image/gif') return true;
  if (!mime || mime === 'application/octet-stream') return namedExtension === 'gif';
  if (mime !== 'image/webp' && mime !== 'image/png' && mime !== 'image/apng') return false;

  const ctor = (globalThis as unknown as { ImageDecoder?: ImageDecoderConstructor }).ImageDecoder;
  if (!ctor) return false;

  try {
    const data = await file.arrayBuffer();
    const decoder = new ctor({ data, type: mime });
    await decoder.tracks.ready;
    return (decoder.tracks.selectedTrack?.frameCount ?? 0) > 1;
  } catch {
    return false;
  }
}

/**
 * Upload name for a profile image. The server derives the stored MIME type
 * from this extension (`packages/server/src/routes/files.ts`), so it must
 * match the bytes: an animated GIF renamed `.webp` would be served with the
 * wrong content type.
 */
export function profileImageFileName(kind: ProfileImageKind, file: File): string {
  const extension = MIME_EXTENSIONS[file.type.toLowerCase()] ?? nameExtension(file.name);
  return `${kind}.${extension || 'png'}`;
}
