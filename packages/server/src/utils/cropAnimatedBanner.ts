import sharp from 'sharp';
export interface BannerCrop { x: number; y: number; width: number; height: number }
export function isBannerCrop(value: unknown): value is BannerCrop {
  if (!value || typeof value !== 'object') return false;
  const crop = value as BannerCrop;
  return [crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0;
}

/** Create a separate cropped GIF. The original upload is preserved. */
export async function cropAnimatedBanner(input: string, output: string, crop: BannerCrop): Promise<void> {
  if (!isBannerCrop(crop)) throw new Error('Invalid banner crop');
  const metadata = await sharp(input, { animated: true }).metadata();
  const width = metadata.width ?? 0;
  const frameHeight = metadata.pageHeight ?? metadata.height ?? 0;
  const pages = metadata.pages ?? 1;
  if (metadata.format !== 'gif' || pages > 240 || width * frameHeight * pages > 64_000_000 || crop.x + crop.width > width || crop.y + crop.height > frameHeight) throw new Error('Banner crop exceeds image bounds or decode limits');
  await sharp(input, { animated: true, limitInputPixels: 64_000_000 })
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .resize({ width: 1280, height: 720, fit: 'inside', withoutEnlargement: true })
    .gif().toFile(output);
}
