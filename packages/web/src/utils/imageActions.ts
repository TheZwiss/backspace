import { useUIStore } from '../stores/uiStore';

/**
 * Downloads an image by fetching it as a blob and triggering a download.
 * Falls back to opening in a new tab if CORS blocks the fetch.
 */
export async function saveImage(url: string, filename?: string): Promise<void> {
  const derivedFilename = filename ?? url.split('/').pop()?.split('?')[0] ?? 'image';

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = derivedFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(url, '_blank', 'noopener');
    useUIStore.getState().addToast('Opened in new tab', 'info', 3000);
  }
}

/**
 * Copies an image to the clipboard as PNG.
 * Falls back to copying the URL as text if CORS or clipboard API blocks it.
 */
export async function copyImageToClipboard(url: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    let pngBlob: Blob;

    if (blob.type === 'image/png') {
      pngBlob = blob;
    } else {
      pngBlob = await convertToPng(blob);
    }

    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': pngBlob }),
    ]);
  } catch {
    await navigator.clipboard.writeText(url);
    useUIStore.getState().addToast('Copied image link', 'info', 3000);
  }
}

/** Draws a blob onto an offscreen canvas and exports as PNG. */
function convertToPng(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const blobUrl = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(blobUrl);
        reject(new Error('Canvas 2D context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(blobUrl);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error('Canvas toBlob returned null'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error('Failed to load image for conversion'));
    };
    img.src = blobUrl;
  });
}
