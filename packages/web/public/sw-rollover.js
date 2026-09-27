/*
 * Imported into the generated service worker (vite.config.ts,
 * `workbox.importScripts`). It lets this build's worker replace a worker from
 * before the prompt-mode update flow, which would otherwise wait forever.
 *
 * Workers from those builds took over on their own, and their pages never post
 * SKIP_WAITING. The old worker also keeps answering navigations with its own
 * precached index.html, so reloading does not help either: a tab or a desktop
 * window left open would stay on the old build until every one of them closed.
 *
 * Every worker from this protocol on creates the marker cache when it
 * activates, so a worker without it is necessarily an older one. On install,
 * if a worker is active and the marker is missing, this worker skips waiting,
 * and the old pages reload through their own controllerchange listener,
 * exactly as they did on every update before. Otherwise it waits for
 * SwAutoUpdate's SKIP_WAITING. The marker is written on activate, not
 * install, because a worker that installs but never activates must not make
 * an older active worker look current.
 *
 * The marker name must not contain "-precache-": workbox's
 * cleanupOutdatedCaches deletes caches whose names do.
 */
(function registerProtocolRollover(scope) {
  const MARKER_CACHE = 'backspace-sw-protocol-prompt-v1';

  scope.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      // A failure here must not fail the install: the worker then simply
      // waits for SKIP_WAITING like any other update.
      try {
        if (!scope.registration.active) return;
        if (await scope.caches.has(MARKER_CACHE)) return;
        await scope.skipWaiting();
      } catch (error) {
        console.warn('[sw-rollover] Could not check the protocol marker', error);
      }
    })());
  });

  scope.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      try {
        await scope.caches.open(MARKER_CACHE);
      } catch (error) {
        console.warn('[sw-rollover] Could not write the protocol marker', error);
      }
    })());
  });
})(self);
