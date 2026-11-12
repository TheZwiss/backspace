import { useEffect, useRef } from 'react';
import { useUIStore } from '../stores/uiStore';

/**
 * The system Back button (Android) and the browser's back gesture should close an
 * open sheet or dialog, not leave the screen behind it.
 *
 * The screen stack already follows history (`MobileShell` pops it on `popstate`),
 * but a sheet is not a screen: opening one pushed nothing, so Back popped the
 * chat out from under the sheet and left the person on the list with the sheet
 * gone, or did nothing at all.
 *
 * Each open overlay registers here. A marker entry with the same URL is pushed
 * (the router sees no route change) and the next Back lands on the entry below
 * it, which this module reports as "consumed": the overlay closes and the screen
 * stack is not touched. Closing an overlay any other way takes its marker off the
 * history again.
 *
 * Only the mobile shell uses this: a desktop window has no Back-to-dismiss
 * convention, and its history is the route's alone.
 */

interface OverlayEntry {
  id: number;
  close: () => void;
  /** The marker was pushed (it is deferred past a StrictMode replay). */
  pushed: boolean;
  /** Back already took the marker off; closing must not undo anything. */
  consumed: boolean;
}

const MARKER_KEY = '__overlayId';
const stack: OverlayEntry[] = [];
let sequence = 0;
/** `popstate` events this module caused itself (`history.back()` to remove a marker). */
let echoes = 0;
let echoTimer: ReturnType<typeof setTimeout> | null = null;

function expectEcho(): void {
  echoes++;
  if (echoTimer) clearTimeout(echoTimer);
  // The browser may not fire the event (nothing to go back to); never swallow a real Back for long
  echoTimer = setTimeout(() => { echoes = 0; echoTimer = null; }, 600);
}

function markerOf(state: unknown): number | null {
  if (state && typeof state === 'object' && MARKER_KEY in state) {
    const id = (state as Record<string, unknown>)[MARKER_KEY];
    return typeof id === 'number' ? id : null;
  }
  return null;
}

/**
 * Register an open overlay. Returns the function that unregisters it when the
 * overlay closes (by any means).
 */
export function registerBackDismiss(close: () => void): () => void {
  const entry: OverlayEntry = { id: ++sequence, close, pushed: false, consumed: false };
  stack.push(entry);
  // Deferred: React's StrictMode mounts, unmounts and mounts again in one commit,
  // and a marker pushed and removed in the same tick would be undone out of order.
  queueMicrotask(() => {
    if (!stack.includes(entry) || entry.pushed) return;
    try {
      // Keep the router's own state (key, idx) so it does not mistake the entry for navigation
      window.history.pushState({ ...(window.history.state ?? {}), [MARKER_KEY]: entry.id }, '');
      entry.pushed = true;
    } catch {
      // History unavailable (sandboxed frame): the overlay still closes on its own controls
    }
  });
  return () => {
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    if (!entry.pushed || entry.consumed) return;
    // Closed by something other than Back. Decide after the closing handler has
    // run: it may have pushed a screen over the marker, and going back then
    // would land on the marker instead of leaving the new screen where it is.
    setTimeout(() => {
      if (markerOf(window.history.state) === entry.id) {
        expectEcho();
        window.history.back();
      }
    }, 0);
  };
}

/**
 * Called first by the shell's `popstate` handler. True when the event was this
 * module's business (an overlay was dismissed, or one of its own echoes) and the
 * screen stack must be left alone.
 */
export function handleOverlayPopState(): boolean {
  if (echoes > 0) {
    echoes--;
    return true;
  }
  const top = stack[stack.length - 1];
  if (top) {
    stack.pop();
    top.consumed = true;
    top.close();
    return true;
  }
  // Landed on a marker whose overlay is long gone. With a screen to pop, that is
  // the shell's Back as usual; with nothing to pop, step over the dead entry.
  if (markerOf(window.history.state) !== null && inMobileShell() && useUIStore.getState().mobileStack.length === 0) {
    expectEcho();
    window.history.back();
    return true;
  }
  return false;
}

/** Test seam: forget everything, as a fresh page would. */
export function resetOverlayBack(): void {
  stack.length = 0;
  echoes = 0;
  if (echoTimer) { clearTimeout(echoTimer); echoTimer = null; }
}

/** True in the mobile shell. Defensive: a test double for the store need not implement `getState`. */
function inMobileShell(): boolean {
  return typeof useUIStore.getState === 'function' && useUIStore.getState().isMobile === true;
}

/** `registerBackDismiss` for the mobile shell only; null on desktop, where Back has no dismiss convention. */
export function registerBackDismissOnMobile(close: () => void): (() => void) | null {
  return inMobileShell() ? registerBackDismiss(close) : null;
}

/** Make Back close this overlay while `active` (mobile shell only). */
export function useBackDismiss(onClose: () => void, active = true): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!active) return;
    return registerBackDismissOnMobile(() => latest.current()) ?? undefined;
  }, [active]);
}
