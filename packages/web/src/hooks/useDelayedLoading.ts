import { useState, useEffect, useRef } from 'react';

/**
 * Gates a loading boolean behind a delay threshold to prevent skeleton flicker.
 * - Shows nothing for the first `threshold` ms (default 200)
 * - Once shown, keeps skeleton visible for at least `minDisplay` ms (default 300)
 */
export function useDelayedLoading(
  isLoading: boolean,
  options?: { threshold?: number; minDisplay?: number },
): boolean {
  const threshold = options?.threshold ?? 200;
  const minDisplay = options?.minDisplay ?? 300;

  const [show, setShow] = useState(false);
  const thresholdRef = useRef<ReturnType<typeof setTimeout>>();
  const minDisplayRef = useRef<ReturnType<typeof setTimeout>>();
  const displayStartRef = useRef(0);

  useEffect(() => {
    if (isLoading) {
      thresholdRef.current = setTimeout(() => {
        displayStartRef.current = Date.now();
        setShow(true);
      }, threshold);
    } else {
      // Loading finished — clear threshold timer if it hasn't fired yet
      clearTimeout(thresholdRef.current);

      if (show) {
        // Skeleton is visible — enforce minimum display time
        const elapsed = Date.now() - displayStartRef.current;
        const remaining = minDisplay - elapsed;
        if (remaining > 0) {
          minDisplayRef.current = setTimeout(() => setShow(false), remaining);
        } else {
          setShow(false);
        }
      }
    }

    return () => {
      clearTimeout(thresholdRef.current);
      clearTimeout(minDisplayRef.current);
    };
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  return show;
}
