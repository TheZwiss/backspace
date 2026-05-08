import { useEffect, useState } from 'react';

/**
 * Live geometry of `window.visualViewport`, plus a derived `inset` string
 * that floating overlays (e.g. the chat composer) can paste into a `bottom`
 * style to sit just above the iOS / Android soft keyboard when one is open,
 * or above the system home indicator when one is not.
 *
 * Why this hook exists
 * --------------------
 * On iOS Safari (and PWA), `env(safe-area-inset-bottom)` is defined relative
 * to the **layout** viewport, not the **visual** viewport. When the soft
 * keyboard slides up, the layout viewport stays the same height and the home-
 * indicator inset still reports ~34 px — so a composer pinned to
 * `bottom: env(safe-area-inset-bottom) + 6px` ends up `~40px` above the
 * layout-bottom, which on iPhone 14 Pro is `300+ px` above the keyboard top.
 *
 * `window.visualViewport` reports the live size of the visible region. When
 * the keyboard is open, `visualViewport.height` shrinks and
 * `visualViewport.offsetTop` may become non-zero. The bottom of the visual
 * viewport (in layout-viewport coordinates) is therefore
 * `visualViewport.offsetTop + visualViewport.height`. The distance between
 * that line and the layout-viewport bottom is the keyboard occlusion:
 *   keyboardOcclusion = window.innerHeight - (offsetTop + height)
 *
 * When the keyboard is closed, that value is ~0 and we fall back to the
 * standard `safe-area-inset-bottom` so the overlay sits above the home
 * indicator. When the keyboard is open, we use the keyboard occlusion
 * directly — `safe-area-inset-bottom` no longer applies because the home
 * indicator is occluded by the keyboard.
 *
 * iOS PWA standalone caveats
 * --------------------------
 * In iOS Safari standalone PWA mode, `visualViewport.resize` events are
 * known to fire late, fire only once after the keyboard finishes animating,
 * or in some iOS versions not fire at all for the keyboard transition. To
 * cover those cases we additionally:
 *   1. Listen to `focusin` / `focusout` on `window` and re-measure (a focus
 *      change on a text input is a strong signal that the keyboard is about
 *      to open / close).
 *   2. Poll `visualViewport` for ~600ms after a focus change so we catch the
 *      shrunk height even when no `resize` event ever lands.
 *   3. Listen to `vv.scroll` events too — on some iOS builds the keyboard
 *      transition fires `scroll` (offsetTop change) without `resize`.
 *
 * Consumers
 * ---------
 * - `MobileShell.tsx` reads `{ height, keyboardOpen }` and uses `height` as
 *   the container's CSS height when the keyboard is open. This is the
 *   primary mechanism for the composer to sit flush above the keyboard:
 *   the container shrinks to the visible region, so a `position: absolute;
 *   bottom: 0` child naturally lands on the keyboard's top edge regardless
 *   of how reliably the `inset` value tracks the keyboard.
 * - `MessageInput.tsx` reads `{ value, keyboardOpen }` and uses them only
 *   on desktop fallback paths and for the breathing-room toggle (above the
 *   home indicator vs flush with the keyboard).
 */
export interface VisualViewportInset {
  /** CSS string for `bottom`: either `env(safe-area-inset-bottom)` or `<n>px`. */
  value: string;
  /** True if the soft keyboard is occluding the bottom of the layout viewport. */
  keyboardOpen: boolean;
  /**
   * Live `visualViewport.height` in pixels, or `null` if `visualViewport` is
   * unavailable. Consumers that want to size a container to the visible
   * region (e.g. MobileShell when the keyboard is open) read this directly.
   */
  height: number | null;
  /**
   * Live `visualViewport.offsetTop` in pixels (0 when no scroll occlusion at
   * the top of the visible region), or `null` if `visualViewport` is
   * unavailable.
   */
  offsetTop: number | null;
}

const FALLBACK: VisualViewportInset = {
  value: 'env(safe-area-inset-bottom)',
  keyboardOpen: false,
  height: null,
  offsetTop: null,
};

export function useVisualViewportInset(): VisualViewportInset {
  const [inset, setInset] = useState<VisualViewportInset>(FALLBACK);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pollDeadline = 0;

    const measure = () => {
      // Distance from the bottom of the layout viewport (window.innerHeight)
      // to the bottom of the visual viewport (offsetTop + height). On iOS
      // when the keyboard is up, this equals the keyboard's height.
      const occlusion = window.innerHeight - (vv.offsetTop + vv.height);
      // Sub-pixel noise on iOS — anything under 1 px we treat as "no
      // keyboard" so we don't flap between safe-area and a 0.4 px offset.
      const next: VisualViewportInset =
        occlusion > 1
          ? {
              value: `${Math.round(occlusion)}px`,
              keyboardOpen: true,
              height: vv.height,
              offsetTop: vv.offsetTop,
            }
          : {
              value: 'env(safe-area-inset-bottom)',
              keyboardOpen: false,
              height: vv.height,
              offsetTop: vv.offsetTop,
            };

      // Functional update + shallow compare so identical re-measurements
      // don't churn React state every animation frame during keyboard
      // transitions.
      setInset((prev) =>
        prev.value === next.value &&
        prev.keyboardOpen === next.keyboardOpen &&
        prev.height === next.height &&
        prev.offsetTop === next.offsetTop
          ? prev
          : next,
      );
    };

    const update = () => {
      // Schedule a single rAF — `resize`/`scroll` on visualViewport can fire
      // many times per frame on iOS during keyboard transitions; coalescing
      // avoids redundant React state updates.
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };

    /**
     * iOS PWA fallback: poll for ~600 ms after a focus change. iOS Safari
     * (especially in standalone PWA mode) often fails to dispatch a
     * `visualViewport.resize` event when the soft keyboard opens — but the
     * `vv.height` value itself does update once the keyboard finishes
     * animating. Polling at ~16 ms intervals from `focusin` until the
     * deadline ensures we observe the shrunk height even when no event
     * fires. The interval clears as soon as we observe a steady state for
     * two consecutive frames.
     */
    let lastPolledHeight = vv.height;
    let stableFrames = 0;
    const startPolling = (durationMs: number) => {
      pollDeadline = performance.now() + durationMs;
      lastPolledHeight = vv.height;
      stableFrames = 0;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        measure();
        if (vv.height === lastPolledHeight) {
          stableFrames += 1;
        } else {
          lastPolledHeight = vv.height;
          stableFrames = 0;
        }
        if (stableFrames >= 3 || performance.now() > pollDeadline) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          // One last measurement after we stop, in case the value just
          // settled this tick.
          measure();
        }
      }, 32);
    };

    const onFocusChange = (e: FocusEvent) => {
      // Only react to focus changes on text-entry elements — focusing a
      // <button> never opens the soft keyboard, so polling for it would
      // waste cycles.
      const t = e.target as Element | null;
      if (!t) return;
      const tag = t.tagName;
      const editable =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (t as HTMLElement).isContentEditable === true;
      if (!editable) return;
      // Immediate measure + a polling window for laggy iOS PWA event flows.
      update();
      startPolling(600);
    };

    measure();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('focusin', onFocusChange, true);
    window.addEventListener('focusout', onFocusChange, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (pollTimer) clearInterval(pollTimer);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('focusin', onFocusChange, true);
      window.removeEventListener('focusout', onFocusChange, true);
    };
  }, []);

  return inset;
}
