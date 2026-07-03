import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drag-to-close gesture hook for bottom sheets.
 *
 * Returns the props you spread onto the *drag-handle area* (typically the
 * sheet's top section: visible handle pill + header), plus the live
 * `dragOffset` to apply as a `translateY` on the sheet container.
 *
 * Behaviour
 * ─────────
 * - The user must start the touch on the drag-handle/header area (the spread
 *   props live on a single element). Touches on the body/scrollable region are
 *   never captured, so internal scrolling is unaffected.
 * - While the finger moves down, the sheet follows 1:1 via `translateY`. Up-
 *   ward drag is clamped to 0 (rubber-band kept simple — we don't want any
 *   visual feedback that suggests "drag up to expand", which we don't support).
 * - On release:
 *   - If the drag distance exceeds the close threshold *or* the user is
 *     flicking down faster than the velocity threshold, we trigger the close
 *     animation: `translateY` glides from the current offset to off-screen
 *     (200 ms ease-out), THEN `onClose` fires. We never snap back to 0 first.
 *   - Otherwise we snap back to 0 with the same easing.
 * - Lateral scroll is not blocked; vertical drag past a small dead-zone calls
 *   `preventDefault` so iOS Safari doesn't simultaneously scroll the page or
 *   trigger pull-to-refresh on Chrome Android.
 *
 * Open-keyframe coexistence
 * ─────────────────────────
 * Consumers typically apply an `animate-slide-up-sheet` CSS keyframe on mount
 * (a 200 ms `translateY(100%) → translateY(0)` ramp). That keyframe must be
 * suppressed any time we're driving `transform` ourselves via inline style —
 * otherwise React re-render cycles will re-add the class and the keyframe
 * will fight (or replace) the inline transform. The hook exposes
 * `hasInteracted` for this purpose: it flips `true` on the first touchstart
 * and stays `true` for the lifetime of the consumer mount, so consumers can
 * write `${hasInteracted ? '' : 'animate-slide-up-sheet'}`. This gates the
 * keyframe both during drag (isDragging), during snap-back (isDragging=false
 * + dragOffset transitioning back to 0), and during the close-out animation
 * (isClosing=true + dragOffset = viewport height).
 *
 * The hook is otherwise animation-agnostic. The close-out transition uses
 * `transform Xms ease-out` applied via inline style, where X is
 * `closeAnimationMs` (defaults to 200, matching `slide-up-sheet`'s timing).
 *
 * Tap-on-handle is treated as a no-op: a touch that ends within the dead-zone
 * without crossing the velocity/threshold gates simply snaps back, which
 * matches iOS native sheet behaviour (a tap on the grabber doesn't dismiss).
 */

interface DragToCloseOptions {
  onClose: () => void;
  /**
   * Threshold in pixels below the resting position above which the sheet
   * commits to closing on release. If the consumer doesn't pass a height, we
   * fall back to a fixed 100 px threshold.
   */
  closeThreshold?: number;
  /**
   * Velocity in px/ms; releasing faster than this in the down direction
   * commits to a close regardless of distance.
   */
  velocityThreshold?: number;
  /**
   * Optional override for the closing animation duration (ms). Default 200
   * matches `tailwind.config.js`'s `slide-up-sheet` keyframe.
   */
  closeAnimationMs?: number;
  /** Disable the gesture without unmounting the consumer. */
  enabled?: boolean;
}

interface DragToCloseResult {
  /** Inline style to spread onto the sheet container. */
  sheetStyle: React.CSSProperties;
  /** Spread onto the drag-handle / header area. */
  handleProps: {
    onTouchStart: (e: React.TouchEvent) => void;
  };
  /** True while the user is actively dragging. */
  isDragging: boolean;
  /** True while the close-out animation is running (after threshold met). */
  isClosing: boolean;
  /**
   * True once the user has touched the drag handle at least once. Stays true
   * for the rest of the component's lifetime. Consumers use this to suppress
   * their open-animation keyframe so it doesn't fight the inline transform on
   * snap-back / close-out.
   */
  hasInteracted: boolean;
}

export function useDragToClose({
  onClose,
  closeThreshold = 100,
  velocityThreshold = 0.5,
  closeAnimationMs = 200,
  enabled = true,
}: DragToCloseOptions): DragToCloseResult {
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);

  const startYRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const lastYRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const movedPastDeadzoneRef = useRef<boolean>(false);
  // Latest values used inside document-level listeners. Refs avoid re-binding
  // listeners every render.
  const enabledRef = useRef(enabled);
  const onCloseRef = useRef(onClose);
  const closeThresholdRef = useRef(closeThreshold);
  const velocityThresholdRef = useRef(velocityThreshold);
  const closeAnimationMsRef = useRef(closeAnimationMs);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { closeThresholdRef.current = closeThreshold; }, [closeThreshold]);
  useEffect(() => { velocityThresholdRef.current = velocityThreshold; }, [velocityThreshold]);
  useEffect(() => { closeAnimationMsRef.current = closeAnimationMs; }, [closeAnimationMs]);

  // Document-level move/end handlers are installed only while a drag is in
  // progress. Installing them on every render would interfere with passive
  // listeners elsewhere; installing them on demand keeps the gesture inert
  // when the sheet is idle.
  useEffect(() => {
    if (!isDragging) return;

    const handleTouchMove = (e: TouchEvent) => {
      if (!enabledRef.current || startYRef.current === null) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dy = touch.clientY - startYRef.current;
      const now = performance.now();
      lastYRef.current = touch.clientY;
      lastTimeRef.current = now;

      // Dead-zone: ignore the first ~6 px to avoid stealing taps and tiny
      // scrolls. Once we cross it, we own the gesture.
      if (!movedPastDeadzoneRef.current) {
        if (Math.abs(dy) < 6) return;
        movedPastDeadzoneRef.current = true;
      }

      // Block native scroll/pull-to-refresh while we drive the offset.
      if (e.cancelable) e.preventDefault();

      // Clamp to 0 on the upward side (no over-scroll).
      const offset = Math.max(0, dy);
      setDragOffset(offset);
    };

    const finalize = (commitClose: boolean, releaseDy: number) => {
      if (commitClose) {
        // Animate from the *current* offset to fully off-screen, then unmount.
        // Critical: we must NOT reset to 0 first — that would visually bounce
        // the sheet up before the close. We flip `isDragging` off (so the
        // inline `transition` engages) and `isClosing` on (so consumers'
        // `hasInteracted`-gated open-keyframe stays suppressed even after
        // unmount), then push the offset to viewport height. The transition
        // smoothly glides the sheet off the bottom; once `closeAnimationMs`
        // elapses we fire `onClose` and the consumer unmounts us.
        setIsDragging(false);
        setIsClosing(true);
        const startOffset = Math.max(0, releaseDy);
        const exitDistance = window.innerHeight; // generous — sheet may be tall
        // Apply the start offset on the same frame we flip transition on, so
        // the browser has a stable "from" value before we animate to "to".
        setDragOffset(startOffset);
        requestAnimationFrame(() => {
          setDragOffset(exitDistance);
        });
        window.setTimeout(() => {
          onCloseRef.current();
        }, closeAnimationMsRef.current);
      } else {
        // Snap back. `isDragging` flips to false → inline transition engages
        // and the sheet glides from `dragOffset` back to 0.
        setIsDragging(false);
        setDragOffset(0);
      }
    };

    const handleTouchEnd = () => {
      if (!enabledRef.current || startYRef.current === null) {
        startYRef.current = null;
        setIsDragging(false);
        setDragOffset(0);
        return;
      }
      const totalDy = Math.max(0, lastYRef.current - startYRef.current);
      const totalDt = Math.max(1, lastTimeRef.current - startTimeRef.current);
      const velocity = totalDy / totalDt; // px/ms, positive = down

      const overDistance = totalDy > closeThresholdRef.current;
      const overVelocity = velocity > velocityThresholdRef.current && totalDy > 16;

      const commitClose =
        movedPastDeadzoneRef.current && (overDistance || overVelocity);

      startYRef.current = null;
      movedPastDeadzoneRef.current = false;
      finalize(commitClose, totalDy);
    };

    const handleTouchCancel = () => {
      startYRef.current = null;
      movedPastDeadzoneRef.current = false;
      // Same as snap-back — engage the transition by flipping isDragging off
      // and letting dragOffset glide to 0.
      setIsDragging(false);
      setDragOffset(0);
    };

    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchCancel);
    return () => {
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [isDragging]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (!enabledRef.current) return;
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (!touch) return;
    startYRef.current = touch.clientY;
    lastYRef.current = touch.clientY;
    startTimeRef.current = performance.now();
    lastTimeRef.current = startTimeRef.current;
    movedPastDeadzoneRef.current = false;
    setIsDragging(true);
    setHasInteracted(true);
    // Reset closing state in case the previous close was cancelled mid-flight
    // (defensive — a successfully closed sheet has unmounted, so this branch
    // only matters if a future consumer keeps the hook alive across close).
    setIsClosing(false);
  }, []);

  // Build the inline style for the sheet container. While dragging we want NO
  // transition (offset must follow the finger 1:1). When releasing without
  // committing OR while closing, we want a transform transition so the
  // movement glides smoothly. Always emit a `transform` value once
  // `hasInteracted` is true so the browser has a stable from-value when
  // dragOffset transitions; before any interaction we leave it undefined so
  // the consumer's open keyframe (CSS `animation`) drives the entry without
  // an inline `transform: translateY(0)` overriding it.
  const transformValue =
    dragOffset > 0
      ? `translateY(${dragOffset}px)`
      : hasInteracted
        ? 'translateY(0)'
        : undefined;

  const sheetStyle: React.CSSProperties = {
    transform: transformValue,
    transition: isDragging
      ? 'none'
      : `transform ${closeAnimationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
    // While dragging or closing, ensure we sit on the GPU's compositor layer
    // and don't re-layout — `transform` alone already does this, but explicit
    // `willChange` prevents any flicker on lower-end devices.
    willChange: isDragging || isClosing ? 'transform' : undefined,
  };

  return {
    sheetStyle,
    handleProps: { onTouchStart },
    isDragging,
    isClosing,
    hasInteracted,
  };
}
