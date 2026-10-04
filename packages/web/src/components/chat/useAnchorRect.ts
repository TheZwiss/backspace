import { useLayoutEffect, useState, type RefObject } from 'react';

export interface AnchorRect {
  left: number;
  /** Distance from the viewport's bottom edge to a point just above the anchor. */
  bottom: number;
  width: number;
}

/**
 * Where to put a popover above `anchorRef`: level with the anchor's left edge and
 * as wide as the anchor. Follows window resizes, scrolling and the anchor growing.
 */
export function useAnchorRect(anchorRef: RefObject<HTMLElement | null>, enabled: boolean): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);

  useLayoutEffect(() => {
    const element = anchorRef.current;
    if (!enabled || !element) return undefined;

    const measure = (): void => {
      const box = element.getBoundingClientRect();
      const next: AnchorRect = { left: box.left, width: box.width, bottom: window.innerHeight - box.top + 4 };
      setRect((prev) => (
        prev && prev.left === next.left && prev.width === next.width && prev.bottom === next.bottom ? prev : next
      ));
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      observer?.disconnect();
    };
  }, [anchorRef, enabled]);

  return rect;
}
