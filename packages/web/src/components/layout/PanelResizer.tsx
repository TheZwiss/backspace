import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/uiStore';
import { RESIZABLE_PANELS, type ResizablePanelId } from '../../stores/panelWidths';
import { layoutPixels } from '../../platform/interfaceScale';

/** Arrow-key step; Shift multiplies it for coarse adjustment. */
const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_LARGE = 64;

interface PanelResizerProps {
  /** The column this divider resizes; its edge, bounds and label come from
   *  `RESIZABLE_PANELS`. Render it inside the column's positioned root. */
  panel: ResizablePanelId;
  className?: string;
}

/**
 * The drag divider for a resizable desktop column. Dragging moves the column's
 * edge with the pointer; arrow keys step it (toward the arrow's direction);
 * End jumps to the maximum; Home, Enter or double-click restore the default,
 * which is also the minimum. Widths are layout pixels, so they survive
 * interface-scale changes.
 */
export function PanelResizer({ panel, className }: PanelResizerProps) {
  const { t } = useTranslation('common');
  const { edge, defaultWidth, maxWidth, labelKey } = RESIZABLE_PANELS[panel];
  const width = useUIStore((s) => s.panelWidths[panel]);
  const setPanelWidth = useUIStore((s) => s.setPanelWidth);
  // The store clamps, so callers pass the raw target width.
  const onResize = useCallback((next: number) => setPanelWidth(panel, next), [panel, setPanelWidth]);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ pointerX: number; width: number } | null>(null);
  // Pointer delta → width delta: positive when moving away from the column.
  const direction = edge === 'right' ? 1 : -1;

  // While dragging, the cursor must stay col-resize and text must not select,
  // even when the pointer leaves the thin handle.
  useEffect(() => {
    if (!dragging) return;
    const { style } = document.body;
    const prevCursor = style.cursor;
    const prevSelect = style.userSelect;
    style.cursor = 'col-resize';
    style.userSelect = 'none';
    return () => {
      style.cursor = prevCursor;
      style.userSelect = prevSelect;
    };
  }, [dragging]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { pointerX: e.clientX, width };
    setDragging(true);
  }, [width]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    // Pointer coordinates are visual pixels; widths are layout pixels.
    onResize(start.width + direction * layoutPixels(e.clientX - start.pointerX));
  }, [direction, onResize]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    dragStart.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    switch (e.key) {
      case 'ArrowLeft': onResize(width - direction * step); break;
      case 'ArrowRight': onResize(width + direction * step); break;
      case 'Home':
      case 'Enter': onResize(defaultWidth); break;
      case 'End': onResize(maxWidth); break;
      default: return;
    }
    e.preventDefault();
  }, [defaultWidth, direction, maxWidth, onResize, width]);

  const edgeClass = edge === 'right' ? '-right-[3px]' : '-left-[3px]';

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t(labelKey)}
      aria-valuenow={width}
      aria-valuemin={defaultWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      data-panel-resizer={panel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(defaultWidth)}
      onKeyDown={handleKeyDown}
      className={`absolute inset-y-0 ${edgeClass} z-10 w-[5px] cursor-col-resize touch-none outline-none transition-colors duration-150 hover:bg-accent-primary/40 focus-visible:bg-accent-primary/60 ${dragging ? 'bg-accent-primary/60' : ''}${className ? ` ${className}` : ''}`}
    />
  );
}
