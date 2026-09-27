import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect, useRef, useState } from 'react';
import { hasVoiceSession, useVoiceStore } from '../../stores/voiceStore';
import { holdVoiceSessionLock, runWhenNoVoiceSession } from '../../utils/voiceSessionLock';

const UPDATE_CHECK_INTERVAL_MS = 60_000;

/**
 * Applies new frontend builds without dropping a voice session.
 *
 * The service worker runs in `prompt` mode, so a new build waits instead of
 * taking over on its own. Applying it swaps the worker, which deletes the old
 * build's precache, and the page then reloads onto the new build, which tears
 * down the LiveKit room. So:
 *
 * - `SKIP_WAITING` is sent only when no tab has a voice session. Each tab
 *   with one holds a shared lock (see `voiceSessionLock`), and the tab that
 *   applies the update does so under the exclusive lock.
 * - The reload waits until this tab has no voice session. Until then the
 *   page keeps running the old build's code.
 *
 * A reload is due whenever one worker replaces another as this page's
 * controller, whichever tab applied the update. The first worker taking
 * control of an uncontrolled page (a first visit, or every desktop launch,
 * since the desktop app clears service workers on start) is not an update and
 * never reloads, but a later replacement in the same session is.
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
    let previousController = container.controller;
    const onControllerChange = () => {
      if (previousController !== null) setReloadPending(true);
      previousController = container.controller;
    };
    container.addEventListener('controllerchange', onControllerChange);
    return () => container.removeEventListener('controllerchange', onControllerChange);
  }, []);

  // Settles once this tab's shared lock is gone. The update below waits for
  // it, so this tab never queues its exclusive request behind itself.
  const sharedLockGone = useRef<Promise<void> | undefined>(undefined);

  useEffect(() => {
    if (!inSession) return;
    const release = holdVoiceSessionLock();
    if (!release) return;
    return () => {
      sharedLockGone.current = release();
    };
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
      sharedLockGone.current,
    ).catch((error: unknown) => {
      console.error('[SwAutoUpdate] Applying the waiting service worker failed', error);
    });
    return () => controller.abort();
  }, [inSession, reloadPending, needRefresh, updateServiceWorker]);

  return null;
}
