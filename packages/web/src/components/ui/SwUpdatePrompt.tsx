import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect, useState } from 'react';
import { hasVoiceSession, useVoiceStore } from '../../stores/voiceStore';
import { holdVoiceSessionLock, runWhenNoVoiceSession } from '../../utils/voiceSessionLock';

const UPDATE_CHECK_INTERVAL_MS = 60_000;

/** Which worker serves the build this page is running, and whether a new controller is another one. */
interface OwnBuildWorker {
  /** True when `next` is a worker other than the one serving this page's build: the page is now stale. */
  passesControlTo(next: ServiceWorker | null): boolean;
}

/**
 * The worker that serves the build this page runs is, in order:
 *
 * 1. the controller at load, for a page loaded through the worker;
 * 2. otherwise the registration's active worker at load. A hard reload
 *    (Shift+reload) bypasses the worker, so the page has no controller, yet
 *    it was loaded next to that worker's build, and when an update activates,
 *    `clientsClaim` hands the page to the new worker with no previous
 *    controller to compare against;
 * 3. otherwise (no worker at all: a first visit, or a desktop launch, which
 *    clears service workers) the first worker to take control, which
 *    installed from the build this page loaded.
 *
 * Control passing to any other worker means the page runs an older build than
 * the one now serving its chunks. After the reload that follows, the new
 * worker is the controller at load, so the rule cannot loop. One reload too
 * many is possible: a hard reload that fetched a build newer than the active
 * worker's reloads once more when that build's worker takes over.
 */
async function ownBuildWorker(container: ServiceWorkerContainer): Promise<OwnBuildWorker> {
  let own: ServiceWorker | null = container.controller;
  if (!own) {
    try {
      own = (await container.getRegistration())?.active ?? null;
    } catch (error: unknown) {
      console.warn('[SwAutoUpdate] Could not read the service worker registration', error);
    }
  }
  return {
    passesControlTo(next) {
      if (!next) return false;
      if (!own) {
        own = next;
        return false;
      }
      return next !== own;
    },
  };
}

/**
 * Applies new frontend builds without dropping a voice session.
 *
 * The service worker runs in `prompt` mode, so a new build waits instead of
 * taking over on its own. Applying it swaps the worker, which deletes the old
 * build's precache, and the page then reloads onto the new build, which ends
 * any call. So:
 *
 * - `SKIP_WAITING` is sent only if, at that moment, no tab of this origin had
 *   a voice session (`hasVoiceSession`). Each tab with one holds a shared Web
 *   Lock (`voiceSessionLock`) and the update is sent under the exclusive one.
 *   A tab that joins a call between that check and the new worker activating
 *   is not protected; that window is the short time the swap itself takes.
 * - The reload waits until this tab has no voice session. Until then the
 *   page keeps running the old build's code.
 *
 * A reload is due whenever control of this page passes to a worker other
 * than the one serving the build it runs (`ownBuildWorker`), whichever tab
 * applied the update. That covers a page loaded with a hard reload, which has
 * no controller until the new worker claims it. The first worker taking
 * control of a page that had no worker at all (a first visit, or every
 * desktop launch, since the desktop app clears service workers on start) is
 * not an update and never reloads, but a later replacement in the same
 * session is.
 *
 * Workers from before this flow never receive `SKIP_WAITING`, so the new
 * worker replaces them on its own (public/sw-rollover.js) and their pages
 * reload at once, as they always did. Known hole: after a rollback to such a
 * build and a deploy forward again, the rollover marker from the first
 * rollover is still in Cache Storage, so the forward build waits until every
 * tab of the rolled-back build has closed.
 */
export function SwAutoUpdate() {
  const [reloadPending, setReloadPending] = useState(false);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      setInterval(() => {
        registration.update();
      }, UPDATE_CHECK_INTERVAL_MS);
    },
    // Suppresses the plugin's own immediate reload, which would ignore voice.
    // The controllerchange listener below decides when a reload is due; the
    // plugin only reports updates on pages that had a controller at load.
    onNeedReload() {},
  });
  const inSession = useVoiceStore(hasVoiceSession);

  useEffect(() => {
    const container = navigator.serviceWorker;
    if (!container) return;
    let disposed = false;
    const ownBuild = ownBuildWorker(container);
    const onControllerChange = () => {
      const next = container.controller;
      void ownBuild.then((tracker) => {
        if (!disposed && tracker.passesControlTo(next)) setReloadPending(true);
      });
    };
    container.addEventListener('controllerchange', onControllerChange);
    return () => {
      disposed = true;
      container.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  useEffect(() => {
    if (!inSession) return;
    const release = holdVoiceSessionLock();
    return release ?? undefined;
  }, [inSession]);

  useEffect(() => {
    if (inSession) return;
    if (reloadPending) {
      window.location.reload();
      return;
    }
    if (!needRefresh) return;
    const controller = new AbortController();
    runWhenNoVoiceSession(
      // Re-read the store: a session can start after the lock was requested
      // but before React has run this effect's cleanup. The effect runs
      // again once that session ends.
      async () => {
        if (hasVoiceSession(useVoiceStore.getState())) return;
        await updateServiceWorker();
      },
      controller.signal,
    ).catch((error: unknown) => {
      console.error('[SwAutoUpdate] Applying the waiting service worker failed', error);
    });
    return () => controller.abort();
  }, [inSession, reloadPending, needRefresh, updateServiceWorker]);

  return null;
}
