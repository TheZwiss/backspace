import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { recordDismissal, shouldShowAsk } from '../../utils/telemetryAsk';
import { HelloModal } from './HelloModal';

/**
 * Mounted once in App. Decides on its own whether the admin of the home
 * instance should be asked: `api.admin.telemetry` always talks to the home
 * origin, and `user.isAdmin` is the home account's flag, so a federated
 * account on a remote instance is never asked about that instance. Nobody is
 * asked before a first admin exists, because there is no session then.
 */
export function TelemetryAsk() {
  const isAdmin = useAuthStore((s) => s.user?.isAdmin === true);
  const telemetry = useSettingsStore((s) => s.telemetry);
  const preview = useSettingsStore((s) => s.telemetryPreview);
  const fetchTelemetry = useSettingsStore((s) => s.fetchTelemetry);
  const fetchPreview = useSettingsStore((s) => s.fetchTelemetryPreview);
  const setEnabled = useSettingsStore((s) => s.setTelemetryEnabled);
  const [open, setOpen] = useState(false);
  // Whether this is a second ask after a no on an earlier release. Captured
  // when the modal opens, because answering changes the status underneath it
  // and the copy must not flip while the admin reads it.
  const [reask, setReask] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  // In-session suppression: the ask is opened at most once per page load, so a
  // dismissal that could not be written to storage still ends it for now.
  const asked = useRef(false);

  useEffect(() => {
    // One status request per admin page load. It is what decides whether to
    // ask, and the instance is the only place that knows: a no made on an
    // earlier release is due again, and no browser-side record can tell.
    if (!isAdmin) return;
    void fetchTelemetry().catch(() => undefined);
  }, [isAdmin, fetchTelemetry]);

  useEffect(() => {
    if (!isAdmin || asked.current) return;
    if (!shouldShowAsk(telemetry, isAdmin, localStorage, Date.now())) return;
    asked.current = true;
    setReask(telemetry?.enabled === false);
    setOpen(true);
    void fetchPreview().catch(() => setPreviewFailed(true));
  }, [isAdmin, telemetry, fetchPreview]);

  // The store forgets this browser's snooze once the answer is stored.
  const onAnswer = useCallback((enabled: boolean) => setEnabled(enabled), [setEnabled]);

  const onDismiss = useCallback(() => {
    // An answer is stored on the instance and settles the ask for every admin,
    // so only a closing without one snoozes the ask in this browser.
    if (useSettingsStore.getState().telemetry?.askDue === true) {
      recordDismissal(localStorage, Date.now());
    }
    setOpen(false);
  }, []);

  if (!open) return null;

  return <HelloModal open reask={reask} onAnswer={onAnswer} onDismiss={onDismiss} preview={preview} previewFailed={previewFailed} />;
}
