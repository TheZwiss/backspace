export interface PixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CropOptions {
  maxDimension?: number;
  quality?: number;
  outputType?: string;
}

export function cropImage(
  imageSrc: string,
  pixelCrop: PixelCrop,
  outputType = 'image/webp',
  options: CropOptions = {},
): Promise<Blob> {
  const { maxDimension, quality = 0.85 } = options;
  const finalType = options.outputType ?? outputType;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Step 1: Draw the crop region at original size
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = pixelCrop.width;
      cropCanvas.height = pixelCrop.height;
      const cropCtx = cropCanvas.getContext('2d');
      if (!cropCtx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }
      cropCtx.drawImage(
        img,
        pixelCrop.x,
        pixelCrop.y,
        pixelCrop.width,
        pixelCrop.height,
        0,
        0,
        pixelCrop.width,
        pixelCrop.height,
      );

      // Step 2: Downscale if either dimension exceeds maxDimension
      let outputCanvas = cropCanvas;
      if (maxDimension && (pixelCrop.width > maxDimension || pixelCrop.height > maxDimension)) {
        const scale = maxDimension / Math.max(pixelCrop.width, pixelCrop.height);
        const scaledW = Math.round(pixelCrop.width * scale);
        const scaledH = Math.round(pixelCrop.height * scale);
        const scaledCanvas = document.createElement('canvas');
        scaledCanvas.width = scaledW;
        scaledCanvas.height = scaledH;
        const scaledCtx = scaledCanvas.getContext('2d');
        if (!scaledCtx) {
          reject(new Error('Failed to get scaled canvas context'));
          return;
        }
        scaledCtx.drawImage(cropCanvas, 0, 0, scaledW, scaledH);
        outputCanvas = scaledCanvas;
      }

      // Step 3: Export to blob — try WebP first, fall back to PNG if unsupported
      outputCanvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else if (finalType === 'image/webp') {
            // WebP not supported (old Safari) — fall back to PNG
            outputCanvas.toBlob(
              (pngBlob) => {
                if (pngBlob) resolve(pngBlob);
                else reject(new Error('Canvas toBlob returned null'));
              },
              'image/png',
            );
          } else {
            reject(new Error('Canvas toBlob returned null'));
          }
        },
        finalType,
        quality,
      );
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageSrc;
  });
}
