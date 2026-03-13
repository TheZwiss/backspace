import path from 'path';
import sharp from 'sharp';

const RESIZABLE_MIMETYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
]);

const THUMBNAIL_MAX_WIDTH = 800;
const THUMBNAIL_QUALITY = 80;

/**
 * Derive a deterministic thumbnail filename from the original.
 * e.g. "123456789.png" → "123456789_thumb.webp"
 */
export function thumbFilename(original: string): string {
  const parsed = path.parse(original);
  return `${parsed.name}_thumb.webp`;
}

/** Check if the given mimetype is a resizable image format. */
export function isResizableImage(mimetype: string): boolean {
  return RESIZABLE_MIMETYPES.has(mimetype);
}

/**
 * Generate a WebP thumbnail for the given image file.
 * Returns the thumbnail filename on success, or null if:
 * - The image is already ≤ THUMBNAIL_MAX_WIDTH px wide
 * - An error occurs (upload still succeeds without thumbnail)
 */
export async function generateThumbnail(
  originalPath: string,
  mimetype: string,
  uploadDir: string,
): Promise<string | null> {
  if (!isResizableImage(mimetype)) return null;

  try {
    const image = sharp(originalPath);
    const metadata = await image.metadata();

    // Skip if the original is already small enough
    if (!metadata.width || metadata.width <= THUMBNAIL_MAX_WIDTH) {
      return null;
    }

    const originalFilename = path.basename(originalPath);
    const thumbName = thumbFilename(originalFilename);
    const thumbPath = path.join(uploadDir, thumbName);

    await sharp(originalPath)
      .resize({ width: THUMBNAIL_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toFile(thumbPath);

    return thumbName;
  } catch (err) {
    console.error('Thumbnail generation failed (non-fatal):', err);
    return null;
  }
}
