import { useState, useEffect, useRef } from 'react';

/** Delays placeholders to avoid flashes and keeps them visible briefly once shown. */
export function useDelayedLoading(
  isLoading: boolean,
  options?: { threshold?: number; minDisplay?: number },
): boolean {
  const threshold = options?.threshold ?? 200;
  const minDisplay = options?.minDisplay ?? 300;
  const [show, setShow] = useState(false);
  const displayStartRef = useRef(0);

  useEffect(() => {
    if (isLoading) {
      if (show) return;
      const timer = setTimeout(() => {
        displayStartRef.current = Date.now();
        setShow(true);
      }, threshold);
      return () => clearTimeout(timer);
    }
    if (!show) return;
    const remaining = Math.max(0, minDisplay - (Date.now() - displayStartRef.current));
    const timer = setTimeout(() => setShow(false), remaining);
    return () => clearTimeout(timer);
    // `show` must be observed: its update can commit after loading has finished.
  }, [isLoading, show, threshold, minDisplay]);

  return show;
}
