import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect, useState } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';

const UPDATE_CHECK_INTERVAL_MS = 60_000;

/**
 * Applies new frontend builds without dropping a live voice session.
 *
 * The service worker runs in `prompt` mode, so a new build waits instead of
 * taking over on its own. Applying it swaps the worker and reloads the page,
 * which tears down the LiveKit room, so both steps are held while the user is
 * in a voice channel or call and run the moment they leave. Until then the old
 * worker keeps serving the old build's cached assets, so the running page stays
 * consistent.
 *
 * The first install never reloads. A fresh worker claiming an uncontrolled page
 * also fires `controllerchange`, so only a controller change on a page that was
 * already controlled at load counts as an update.
 */
export function SwAutoUpdate() {
  // Set when a new worker has taken control of this page, either because this
  // tab applied the update or because another tab did. The page is then running
  // old code against the new worker's cache, so it must reload once it can.
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
    // Replaces the plugin's own immediate reload, which would ignore voice.
    onNeedReload() {
      setReloadPending(true);
    },
  });
  // Covers space voice and DM calls alike: both run through the same LiveKit
  // room, and anything but 'disconnected' means a room is live or being joined.
  const inVoice = useVoiceStore((s) => s.voiceConnectionStatus !== 'disconnected');

  // Catches an update applied from another tab, which the plugin does not
  // report as an update in `prompt` mode.
  useEffect(() => {
    if (!navigator.serviceWorker?.controller) return;
    const onControllerChange = () => setReloadPending(true);
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  }, []);

  useEffect(() => {
    if (inVoice) return;
    if (reloadPending) {
      window.location.reload();
    } else if (needRefresh) {
      void updateServiceWorker();
    }
  }, [inVoice, reloadPending, needRefresh, updateServiceWorker]);

  return null;
}
