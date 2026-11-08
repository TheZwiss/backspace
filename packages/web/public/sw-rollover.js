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
 *
 * Poisoned caches: a server that answers a missing /assets file with
 * index.html (SPA fallback) makes workbox precache HTML under a script URL. The
 * URL carries the content hash, so the entry is never refetched, the page
 * cannot boot, and a page that cannot boot never posts SKIP_WAITING. A worker
 * that finds such an entry in the caches of the worker it replaces therefore
 * skips waiting on its own, and removes the poisoned caches when it activates.
 */
(function registerProtocolRollover(scope) {
  const MARKER_CACHE = 'backspace-sw-protocol-prompt-v1';
  const BUILT_ASSET = /\.(?:js|mjs|css)$/;

  // Names of caches holding a built asset whose stored response is HTML.
  async function poisonedCaches() {
    const poisoned = [];
    for (const name of await scope.caches.keys()) {
      if (name === MARKER_CACHE) continue;
      const cache = await scope.caches.open(name);
      let bad = false;
      for (const request of await cache.keys()) {
        if (!BUILT_ASSET.test(new URL(request.url).pathname)) continue;
        const response = await cache.match(request);
        const type = response && response.headers.get('content-type');
        if (type && /text\/html/i.test(type)) { bad = true; break; }
      }
      if (bad) poisoned.push(name);
    }
    return poisoned;
  }

  scope.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      // A failure here must not fail the install: the worker then simply
      // waits for SKIP_WAITING like any other update.
      try {
        if (!scope.registration.active) return;
        if (!(await scope.caches.has(MARKER_CACHE)) || (await poisonedCaches()).length > 0) {
          await scope.skipWaiting();
        }
      } catch (error) {
        console.warn('[sw-rollover] Could not check the protocol marker', error);
      }
    })());
  });

  scope.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      try {
        await scope.caches.open(MARKER_CACHE);
        for (const name of await poisonedCaches()) await scope.caches.delete(name);
      } catch (error) {
        console.warn('[sw-rollover] Could not write the protocol marker', error);
      }
    })());
  });
})(self);
