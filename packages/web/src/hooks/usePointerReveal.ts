import { useEffect, useRef, useState, type RefObject } from 'react';

/** How long the pointer must sit still before fullscreen chrome fades out. */
export const POINTER_REVEAL_IDLE_MS = 2500;

/**
 * Marks an overlay whose own hit area must not time out from under the
 * pointer. Put it on the chrome band, not on the individual buttons: the
 * pointer can rest in the padding between them while aiming.
 */
export const VOICE_CHROME_ATTR = 'data-voice-chrome';

/**
 * Reveals overlay chrome while the pointer moves over `targetRef`, and hides
 * it again once the pointer has been still for `idleMs`.
 *
 * CSS `:hover` cannot express this, which is the bug this replaces. Hover is
 * geometric: it answers "is the pointer inside this box". On a surface that
 * fills the viewport — exactly what voice fullscreen is — the pointer is
 * inside the box whenever it is anywhere in the window, so a `group-hover`
 * rule resolves to "permanently on" and the chrome never goes away. Idle is a
 * question about time, so it needs a timer.
 *
 * The pointer resting on the chrome itself holds it open: reaching for the
 * hang-up button and stopping to aim must not pull the button away.
 *
 * Returns `false` while inactive and binds nothing, so the non-fullscreen
 * layout keeps its plain hover behaviour, where hover *is* the right model —
 * there the voice surface is a panel with sidebars beside it, and leaving it
 * is something the pointer can actually do.
 */
export function usePointerReveal(
  targetRef: RefObject<HTMLElement | null>,
  active: boolean,
  idleMs: number = POINTER_REVEAL_IDLE_MS,
): boolean {
  const [revealed, setRevealed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearIdleTimer = (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    if (!active) {
      clearIdleTimer();
      setRevealed(false);
      return;
    }

    const target = targetRef.current;
    if (!target) {
      return;
    }

    // Entering fullscreen reveals the chrome, then lets it settle. Without
    // this the controls — including the way back out — would already be gone
    // by the time the transition finishes.
    setRevealed(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setRevealed(false);
    }, idleMs);

    const handlePointerActivity = (event: Event): void => {
      clearIdleTimer();
      setRevealed(true);

      const overChrome =
        event.target instanceof Element && event.target.closest(`[${VOICE_CHROME_ATTR}]`) !== null;
      if (overChrome) {
        // Leave no pending timer: the pointer is on the controls, and the
        // next event that moves it off them starts the countdown again.
        return;
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setRevealed(false);
      }, idleMs);
    };

    target.addEventListener('pointermove', handlePointerActivity);
    target.addEventListener('pointerdown', handlePointerActivity);

    return () => {
      target.removeEventListener('pointermove', handlePointerActivity);
      target.removeEventListener('pointerdown', handlePointerActivity);
      clearIdleTimer();
    };
  }, [active, idleMs, targetRef]);

  return revealed;
}
