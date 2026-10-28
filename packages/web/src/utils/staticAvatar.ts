import { useEffect, useState } from 'react';

// Share one decoded still between every occurrence of the same GIF. The cache
// is bounded because profile pictures can change repeatedly during a session.
const stills = new Map<string, Promise<string | null>>();
const MAX_STILLS = 128;

export function isGifAvatar(src: string): boolean {
  return /^data:image\/gif[;,]/i.test(src) || /\.gif(?:[?#]|$)/i.test(src);
}

function firstFrame(src: string): Promise<string | null> {
  const existing = stills.get(src);
  if (existing) return existing;
  const result = new Promise<string | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        // Cross-origin images without CORS cannot be copied into a canvas.
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
  if (stills.size >= MAX_STILLS) stills.delete(stills.keys().next().value!);
  stills.set(src, result);
  return result;
}

/** Return a still for GIF avatars unless the current surface allows animation. */
export function useStaticAvatar(src: string | null, animate: boolean): string | null {
  const shouldFreeze = !!src && !animate && isGifAvatar(src);
  const [still, setStill] = useState<{ src: string; value: string | null } | null>(null);
  useEffect(() => {
    if (!src || !shouldFreeze) return;
    let active = true;
    void firstFrame(src).then((value) => { if (active) setStill({ src, value }); });
    return () => { active = false; };
  }, [src, shouldFreeze]);
  return shouldFreeze ? (still?.src === src ? still.value : null) : src;
}
