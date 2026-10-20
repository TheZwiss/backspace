import { act, screen } from '@testing-library/react';

/**
 * jsdom has no PointerEvent constructor, and @testing-library's pointer-event
 * fallbacks lose `pointerId` — which the right-panel resize hook matches drags
 * on. A plain MouseEvent dispatched with a pointer event *type* travels through
 * both React's delegated listeners (onPointerDown) and the hook's raw window
 * listeners (move/up), so define the id explicitly and drive the drag with it.
 *
 * act(): the drag updates zustand + hook state on each event; raw dispatching
 * (needed for the pointerId trick) would otherwise warn.
 */
export function firePointer(
  target: Window | Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { pointerId: number; clientX?: number; button?: number },
): void {
  const event = new MouseEvent(type, { bubbles: true, clientX: init.clientX, button: init.button ?? 0 });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Drag the (single) resize separator on screen from `fromX` to `toX`. */
export function dragBorder(fromX: number, toX: number): void {
  const handle = screen.getByRole('separator');
  firePointer(handle, 'pointerdown', { pointerId: 7, clientX: fromX });
  firePointer(window, 'pointermove', { pointerId: 7, clientX: toX });
  firePointer(window, 'pointerup', { pointerId: 7 });
}
