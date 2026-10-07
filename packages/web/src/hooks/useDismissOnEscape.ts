import { useEffect, useRef } from 'react';

/**
 * Closes hover or focus content on Escape (WCAG 1.4.13: content that appears
 * on hover or focus must be dismissable without moving the pointer or focus).
 *
 * While `armed` (a show is pending or the content is open) Escape anywhere in
 * the document calls `onDismiss`: a hovered anchor does not have focus, so its
 * own keydown never sees the key. The caller keeps the content closed until
 * the pointer or focus leaves and comes back, which is simply not reopening
 * until its next enter or focus event.
 */
export function useDismissOnEscape(armed: boolean, onDismiss: () => void): void {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!armed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [armed]);
}
