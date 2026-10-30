import { useSyncExternalStore } from 'react';

// When an element enters browser fullscreen via the Fullscreen API, the user
// agent renders only that element and its descendants. Anything portaled to
// `document.body` (the conventional overlay target) is rendered outside the
// fullscreen layer and is therefore invisible while fullscreen is active.
//
// Overlays that need to remain visible across fullscreen transitions (context
// menus, tooltips, popovers, modals, the screen-share picker) must portal into
// `document.fullscreenElement` while it is non-null and into `document.body`
// otherwise. This hook provides a reactive container that reflects the current
// fullscreen state and re-renders subscribers on every `fullscreenchange`.

export function usePortalContainer(targetDocument: Document = document): Element {
  return useSyncExternalStore(
    (onChange) => {
      targetDocument.addEventListener('fullscreenchange', onChange);
      return () => targetDocument.removeEventListener('fullscreenchange', onChange);
    },
    () => targetDocument.fullscreenElement ?? targetDocument.body,
    () => targetDocument.body,
  );
}
