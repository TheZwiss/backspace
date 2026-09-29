import { useEffect, useState, useCallback, useRef } from 'react';
import { layoutRect } from '../../platform/interfaceScale';

/**
 * Tracks the live composer DOM element and updates the `--composer-clearance`
 * CSS custom property on its parent element using ResizeObserver.
 */
export function useComposerClearance(deps: {
  isMobile: boolean;
  keyboardOpen: boolean;
  textInputFocused: boolean;
  chatReplyTo: unknown;
  stagedCount: number;
}) {
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null);
  const popoverAnchorRef = useRef<HTMLDivElement | null>(null);

  const setComposerRef = useCallback((node: HTMLDivElement | null) => {
    popoverAnchorRef.current = node;
    setComposerEl(node);
  }, []);

  useEffect(() => {
    if (!composerEl) return;
    const target = composerEl.parentElement;
    if (!target) return;
    const el = composerEl;

    const sync = () => {
      // Total clearance = composer height + bottom offset + 12 px gap.
      const composerRect = layoutRect(el.getBoundingClientRect());
      const parentRect = layoutRect(target.getBoundingClientRect());
      const bottomOffset = Math.max(0, parentRect.bottom - composerRect.bottom);
      const clearance = Math.round(composerRect.height + bottomOffset + 12);
      target.style.setProperty('--composer-clearance', `${clearance}px`);
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    ro.observe(target);

    const vv = window.visualViewport;
    const onVv = () => sync();
    if (vv) {
      vv.addEventListener('resize', onVv);
      vv.addEventListener('scroll', onVv);
    }

    return () => {
      ro.disconnect();
      if (vv) {
        vv.removeEventListener('resize', onVv);
        vv.removeEventListener('scroll', onVv);
      }
      target.style.removeProperty('--composer-clearance');
    };
  }, [composerEl, deps.isMobile, deps.keyboardOpen, deps.textInputFocused, deps.chatReplyTo, deps.stagedCount]);

  return { setComposerRef, popoverAnchorRef };
}
