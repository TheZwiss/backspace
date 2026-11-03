import { useLayoutEffect, useState, type RefObject } from 'react';

/** Uses the element's document so detached call windows follow their own focus. */
export function useDocumentActive(element?: RefObject<HTMLElement | null>): boolean {
  const [active, setActive] = useState(() => !document.hidden && document.hasFocus());
  useLayoutEffect(() => {
    const doc = element?.current?.ownerDocument ?? document;
    const view = doc.defaultView;
    const update = () => setActive(!doc.hidden && doc.hasFocus());
    update();
    doc.addEventListener('visibilitychange', update);
    view?.addEventListener('focus', update);
    view?.addEventListener('blur', update);
    return () => {
      doc.removeEventListener('visibilitychange', update);
      view?.removeEventListener('focus', update);
      view?.removeEventListener('blur', update);
    };
  }, [element]);
  return active;
}
