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

function subscribe(onChange: () => void): () => void {
  document.addEventListener('fullscreenchange', onChange);
  return () => document.removeEventListener('fullscreenchange', onChange);
}

function getSnapshot(): Element {
  return document.fullscreenElement ?? document.body;
}

function getServerSnapshot(): Element {
  // Vite SPA — never invoked, but useSyncExternalStore requires a server snapshot
  // for type completeness. Return body so SSR-style renders never crash.
  return document.body;
}

export function usePortalContainer(): Element {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
