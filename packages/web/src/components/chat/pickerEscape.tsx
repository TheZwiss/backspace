import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

interface PickerEscape {
  /** Makes `handler` take the next Escape instead of the picker. Returns the release. */
  claim: (handler: () => void) => () => void;
}

const PickerEscapeContext = createContext<PickerEscape | null>(null);

/**
 * An Escape the picker host leaves alone. One that ends an IME composition
 * (Chinese, Japanese) only cancels the composition. One typed in emoji-mart's
 * skin tone menu goes on to emoji-mart, which closes that menu and keeps the
 * picker open.
 */
function leaveToTarget(event: KeyboardEvent): boolean {
  if (event.isComposing) return true;
  const origin = event.composedPath()[0];
  return origin instanceof Element && isInEmojiMartSkinMenu(origin);
}

/** emoji-mart 5 renders its skin tone menu as `div.menu[role=radiogroup]` in its open shadow root. */
function isInEmojiMartSkinMenu(origin: Element): boolean {
  return origin.getRootNode() instanceof ShadowRoot && origin.closest('.menu[role="radiogroup"]') !== null;
}

/**
 * Escape for a picker host: the composer's popover, the reaction popover and
 * the mobile picker sheet. One Escape undoes one layer. A form that took the
 * picker's place (sticker rename, sticker upload) claims Escape with
 * `usePickerEscapeClaim` and closes first; with no claim, Escape closes the
 * picker.
 *
 * The listener runs in the capture phase on the document, so it sees an
 * Escape before anything inside the picker does: emoji-mart's search input
 * stops every key from bubbling, and an Escape typed there must still close
 * the picker. The key goes no further, so it never also cancels an edit or a
 * reply under the picker.
 */
export function PickerEscapeScope({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const closeRef = useRef(onClose);
  const claims = useRef<Array<() => void>>([]);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || leaveToTarget(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const claimed = claims.current[claims.current.length - 1];
      if (claimed) claimed();
      else closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const scope = useMemo<PickerEscape>(() => ({
    claim: (handler) => {
      claims.current = [...claims.current, handler];
      return () => {
        claims.current = claims.current.filter(claimed => claimed !== handler);
      };
    },
  }), []);

  return <PickerEscapeContext.Provider value={scope}>{children}</PickerEscapeContext.Provider>;
}

/**
 * Takes Escape from the picker host this component is inside, for as long as
 * it is mounted: the host calls `onEscape` instead of closing. Outside a host
 * it does nothing.
 */
export function usePickerEscapeClaim(onEscape: () => void): void {
  const scope = useContext(PickerEscapeContext);
  const handlerRef = useRef(onEscape);

  useEffect(() => {
    handlerRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => scope?.claim(() => handlerRef.current()), [scope]);
}
