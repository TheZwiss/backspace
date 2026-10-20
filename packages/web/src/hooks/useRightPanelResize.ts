import { useCallback, useRef, useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { layoutPixels } from '../platform/interfaceScale';
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_KEYBOARD_STEP,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
} from '../utils/rightPanelResize';

/**
 * Drag-to-resize for the app-shell right column: the space member list, the
 * group-DM roster, and the friends activity list all share one persisted
 * width (uiStore.rightPanelWidth), so the gesture feels identical wherever
 * the column is on screen.
 *
 * The handle sits on the column's left border: dragging left widens it,
 * dragging right narrows it. The width itself lives in uiStore, so the
 * gesture only computes a delta — startWidth + (startX − currentX).
 *
 * Interface scale: the app zooms `document.documentElement` with CSS zoom, so
 * DOM pointers report visual pixels while the panel width is layout pixels.
 * Both coordinates go through layoutPixels() before subtraction, exactly like
 * the PictureInPicture drag (see platform/interfaceScale).
 *
 * Event plumbing: pointerdown takes pointer capture on the handle where the
 * API exists (real browsers) so the drag keeps flowing over iframes, and also
 * hangs move/up listeners on window. The window path is what jsdom tests drive
 * (jsdom has no setPointerCapture), and it also guarantees a stuck drag can
 * never outlive its pointerup. Both paths carry the same pointerId, and the
 * move handler ignores non-matching pointers, so a stray second finger or pen
 * never corrupts an active drag.
 */
export function useRightPanelResize() {
  const width = useUIStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth);
  const [isResizing, setIsResizing] = useState(false);
  const drag = useRef<{ pointerId: number; startWidth: number; startX: number } | null>(null);

  /** Drop the visual drag state and release the page-wide cursor lock. */
  const stopDrag = useCallback((pointerId: number) => {
    if (drag.current?.pointerId !== pointerId) return;
    drag.current = null;
    setIsResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only; a second pointer while one drag runs is ignored.
    if (e.button !== 0 || drag.current) return;
    drag.current = { pointerId: e.pointerId, startWidth: width, startX: e.clientX };

    const el = e.currentTarget;
    // jsdom (tests) has no pointer capture — the window listeners below carry
    // the drag there. Capture here is best-effort, never fatal.
    if (typeof el.setPointerCapture === 'function') {
      try { el.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
    }

    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      // clientX is visual pixels (CSS zoom); convert both ends before the
      // subtraction so the delta lands in the same unit as the stored width.
      setRightPanelWidth(d.startWidth + (layoutPixels(d.startX) - layoutPixels(ev.clientX)));
    };
    const finish = (ev: PointerEvent) => {
      if (drag.current?.pointerId !== ev.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (typeof el.releasePointerCapture === 'function') {
        try { el.releasePointerCapture(ev.pointerId); } catch { /* element may have dropped capture itself */ }
      }
      stopDrag(ev.pointerId);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);

    // Lock the page cursor and kill text selection while dragging: the pointer
    // sweeps across arbitrary content, and the col-resize affordance must
    // follow it instead of flickering over whatever is underneath.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setIsResizing(true);
  }, [width, setRightPanelWidth, stopDrag]);

  /** Double-click restores the shipped default width. */
  const onDoubleClick = useCallback(() => {
    setRightPanelWidth(RIGHT_PANEL_DEFAULT_WIDTH);
  }, [setRightPanelWidth]);

  /**
   * Keyboard resize, per the ARIA window-separator pattern: ArrowLeft moves
   * the border left (wider), ArrowRight moves it right (narrower), and Shift
   * multiplies the step for large adjustments.
   */
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = (e.shiftKey ? 4 : 1) * RIGHT_PANEL_KEYBOARD_STEP;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setRightPanelWidth(width + step);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setRightPanelWidth(width - step);
    }
  }, [width, setRightPanelWidth]);

  return {
    width,
    isResizing,
    min: RIGHT_PANEL_MIN_WIDTH,
    max: RIGHT_PANEL_MAX_WIDTH,
    handleProps: {
      onPointerDown,
      onDoubleClick,
      onKeyDown,
    },
  };
}
