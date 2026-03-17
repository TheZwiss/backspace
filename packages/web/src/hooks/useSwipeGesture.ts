import { useRef, useCallback, useEffect } from 'react';

interface SwipeGestureOptions {
  onSwipeRight?: () => void;
  edgeThreshold?: number;   // px from left edge to start detection (default: 20)
  swipeThreshold?: number;  // px of horizontal movement to trigger (default: 50)
  enabled?: boolean;
}

export function useSwipeGesture({
  onSwipeRight,
  edgeThreshold = 20,
  swipeThreshold = 50,
  enabled = true,
}: SwipeGestureOptions) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipingRef = useRef(false);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!enabled) return;
    const touch = e.touches[0];
    if (!touch) return;
    if (touch.clientX <= edgeThreshold) {
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
      swipingRef.current = false;
    }
  }, [enabled, edgeThreshold]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;

    // If vertical movement exceeds horizontal, cancel swipe detection
    if (Math.abs(dy) > Math.abs(dx) && !swipingRef.current) {
      touchStartRef.current = null;
      return;
    }

    if (dx > swipeThreshold) {
      swipingRef.current = true;
      e.preventDefault();
    }
  }, [swipeThreshold]);

  const handleTouchEnd = useCallback(() => {
    if (swipingRef.current && onSwipeRight) {
      onSwipeRight();
    }
    touchStartRef.current = null;
    swipingRef.current = false;
  }, [onSwipeRight]);

  useEffect(() => {
    if (!enabled) return;
    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [enabled, handleTouchStart, handleTouchMove, handleTouchEnd]);
}
