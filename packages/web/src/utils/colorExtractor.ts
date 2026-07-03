/**
 * Canvas-based dominant color extraction using median-cut quantization.
 * Zero-dependency, client-side only. Used to derive icon-matched gradients
 * for space cards on the Explore page.
 */

// Cache extracted colors by URL to avoid re-processing
const colorCache = new Map<string, string[]>();

interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Extract 2-3 dominant colors from an image URL.
 * Returns hex color strings (e.g. ['#a1b2c3', '#d4e5f6', '#778899']).
 * Results are cached by URL.
 *
 * Returns empty array on failure (CORS, broken image, fully transparent).
 */
export async function extractDominantColors(imageUrl: string): Promise<string[]> {
  const cached = colorCache.get(imageUrl);
  if (cached) return cached;

  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = imageUrl;
    });

    // Downsample to 32x32 for speed
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];

    ctx.drawImage(img, 0, 0, size, size);
    const imageData = ctx.getImageData(0, 0, size, size);
    const { data } = imageData;

    // Collect non-transparent pixels
    const pixels: RGB[] = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! >= 128) {
        pixels.push({ r: data[i]!, g: data[i + 1]!, b: data[i + 2]! });
      }
    }

    if (pixels.length === 0) {
      colorCache.set(imageUrl, []);
      return [];
    }

    // Median-cut quantization to 3 buckets
    const buckets = medianCut(pixels, 3);
    const colors = buckets.map(bucket => {
      const avg = averageColor(bucket);
      return rgbToHex(avg.r, avg.g, avg.b);
    });

    // Deduplicate very similar colors (within distance 30)
    const unique = deduplicateColors(colors);

    colorCache.set(imageUrl, unique);
    return unique;
  } catch {
    colorCache.set(imageUrl, []);
    return [];
  }
}

/**
 * Convert extracted colors to a CSS gradient string (135deg, multi-stop).
 */
export function colorsToGradient(colors: string[]): string {
  if (colors.length === 0) return '';
  if (colors.length === 1) return colors[0]!;
  if (colors.length === 2) return `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`;
  return `linear-gradient(135deg, ${colors[0]}, ${colors[1]}, ${colors[2]})`;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function medianCut(pixels: RGB[], targetBuckets: number): RGB[][] {
  if (pixels.length === 0) return [];

  let buckets: RGB[][] = [pixels];

  while (buckets.length < targetBuckets) {
    // Find the bucket with the widest color range
    let widestIndex = 0;
    let widestRange = -1;

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i]!;
      if (bucket.length < 2) continue;
      const range = getWidestChannelRange(bucket);
      if (range.range > widestRange) {
        widestRange = range.range;
        widestIndex = i;
      }
    }

    if (widestRange <= 0) break;

    const bucket = buckets[widestIndex]!;
    const { channel } = getWidestChannelRange(bucket);

    // Sort by the widest channel and split at median
    bucket.sort((a, b) => a[channel] - b[channel]);
    const mid = Math.floor(bucket.length / 2);

    buckets.splice(widestIndex, 1, bucket.slice(0, mid), bucket.slice(mid));
  }

  return buckets.filter(b => b.length > 0);
}

function getWidestChannelRange(pixels: RGB[]): { channel: 'r' | 'g' | 'b'; range: number } {
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
  for (const p of pixels) {
    if (p.r < minR) minR = p.r;
    if (p.r > maxR) maxR = p.r;
    if (p.g < minG) minG = p.g;
    if (p.g > maxG) maxG = p.g;
    if (p.b < minB) minB = p.b;
    if (p.b > maxB) maxB = p.b;
  }
  const rRange = maxR - minR;
  const gRange = maxG - minG;
  const bRange = maxB - minB;

  if (rRange >= gRange && rRange >= bRange) return { channel: 'r', range: rRange };
  if (gRange >= bRange) return { channel: 'g', range: gRange };
  return { channel: 'b', range: bRange };
}

function averageColor(pixels: RGB[]): RGB {
  let r = 0, g = 0, b = 0;
  for (const p of pixels) {
    r += p.r;
    g += p.g;
    b += p.b;
  }
  const n = pixels.length;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function colorDistance(hex1: string, hex2: string): number {
  const r1 = parseInt(hex1.slice(1, 3), 16);
  const g1 = parseInt(hex1.slice(3, 5), 16);
  const b1 = parseInt(hex1.slice(5, 7), 16);
  const r2 = parseInt(hex2.slice(1, 3), 16);
  const g2 = parseInt(hex2.slice(3, 5), 16);
  const b2 = parseInt(hex2.slice(5, 7), 16);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function deduplicateColors(colors: string[]): string[] {
  const result: string[] = [];
  for (const c of colors) {
    if (!result.some(existing => colorDistance(existing, c) < 30)) {
      result.push(c);
    }
  }
  return result;
}
