import React, { useRef, useCallback, useEffect } from 'react';

interface UseLongPressOptions {
  delay?: number;
  moveThreshold?: number;
}

interface LongPressPosition {
  clientX: number;
  clientY: number;
}

type LongPressCallback = (position: LongPressPosition) => void;

interface LongPressHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchCancel: (e: React.TouchEvent) => void;
}

export function useLongPress(
  callback: LongPressCallback,
  options?: UseLongPressOptions,
): LongPressHandlers {
  const delay = options?.delay ?? 500;
  const moveThreshold = options?.moveThreshold ?? 10;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originRef = useRef<LongPressPosition>({ clientX: 0, clientY: 0 });
  const firedRef = useRef(false);
  const callbackRef = useRef(callback);

  // Keep callback ref fresh to avoid stale closures
  callbackRef.current = callback;

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;

    firedRef.current = false;
    originRef.current = { clientX: touch.clientX, clientY: touch.clientY };

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      callbackRef.current(originRef.current);
    }, delay);
  }, [delay]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (timerRef.current === null) return;

    const touch = e.touches[0];
    if (!touch) return;

    const dx = touch.clientX - originRef.current.clientX;
    const dy = touch.clientY - originRef.current.clientY;
    const distance = Math.hypot(dx, dy);

    if (distance > moveThreshold) {
      cancel();
    }
  }, [moveThreshold, cancel]);

  const onTouchEnd = useCallback((_e: React.TouchEvent) => {
    cancel();
    // If the long press fired, suppress the subsequent click event
    if (firedRef.current) {
      // The ghost click fires ~300ms after touchend on some browsers.
      // We set a capture-phase click listener that prevents it.
      const suppressClick = (clickEvent: MouseEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
      };
      document.addEventListener('click', suppressClick, { capture: true, once: true });
      // Safety: remove the listener after 500ms in case no click fires
      setTimeout(() => {
        document.removeEventListener('click', suppressClick, { capture: true });
      }, 500);
      firedRef.current = false;
    }
  }, [cancel]);

  const onTouchCancel = useCallback((_e: React.TouchEvent) => {
    cancel();
    firedRef.current = false;
  }, [cancel]);

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel };
}
