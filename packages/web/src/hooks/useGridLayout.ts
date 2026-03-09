import { useState, useEffect, useRef, type RefObject } from 'react';

interface GridLayoutOptions {
  gap?: number;
  aspectRatio?: number;
  padding?: number;
}

interface GridLayout {
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

export function useGridLayout(
  containerRef: RefObject<HTMLElement | null>,
  tileCount: number,
  options: GridLayoutOptions = {},
): GridLayout {
  const { gap = 8, aspectRatio = 16 / 9, padding = 12 } = options;

  const [layout, setLayout] = useState<GridLayout>({
    cols: 1,
    rows: 1,
    tileWidth: 320,
    tileHeight: 180,
  });

  const prevRef = useRef<GridLayout>(layout);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || tileCount === 0) return;

    const compute = () => {
      const containerWidth = el.clientWidth - padding * 2;
      const containerHeight = el.clientHeight - padding * 2;
      if (containerWidth <= 0 || containerHeight <= 0) return;

      let bestCols = 1;
      let bestArea = 0;
      let bestW = 0;
      let bestH = 0;

      for (let cols = 1; cols <= tileCount; cols++) {
        const rows = Math.ceil(tileCount / cols);

        const maxTileW = (containerWidth - gap * (cols - 1)) / cols;
        const maxTileH = (containerHeight - gap * (rows - 1)) / rows;

        // Fit within both constraints while maintaining aspect ratio
        let tileW = maxTileW;
        let tileH = tileW / aspectRatio;

        if (tileH > maxTileH) {
          tileH = maxTileH;
          tileW = tileH * aspectRatio;
        }

        const area = tileW * tileH;
        if (area > bestArea) {
          bestArea = area;
          bestCols = cols;
          bestW = Math.floor(tileW);
          bestH = Math.floor(tileH);
        }
      }

      const bestRows = Math.ceil(tileCount / bestCols);
      const next: GridLayout = {
        cols: bestCols,
        rows: bestRows,
        tileWidth: bestW,
        tileHeight: bestH,
      };

      const prev = prevRef.current;
      if (
        prev.cols !== next.cols ||
        prev.rows !== next.rows ||
        prev.tileWidth !== next.tileWidth ||
        prev.tileHeight !== next.tileHeight
      ) {
        prevRef.current = next;
        setLayout(next);
      }
    };

    compute();

    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef, tileCount, gap, aspectRatio, padding]);

  return layout;
}
