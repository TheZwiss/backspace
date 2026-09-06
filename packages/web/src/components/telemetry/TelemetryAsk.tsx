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
  // In-session suppression: the ask is opened at most once per page load, so a
  // dismissal that could not be written to storage still ends it for now.
  const asked = useRef(false);

  useEffect(() => {
    if (!isAdmin) return;
    void fetchTelemetry().catch(() => undefined);
  }, [isAdmin, fetchTelemetry]);

  useEffect(() => {
    if (!isAdmin || asked.current) return;
    if (!shouldShowAsk(telemetry, isAdmin, localStorage, Date.now())) return;
    asked.current = true;
    setOpen(true);
    void fetchPreview().catch(() => undefined);
  }, [isAdmin, telemetry, fetchPreview]);

  const onAnswer = useCallback((enabled: boolean) => setEnabled(enabled), [setEnabled]);

  const onDismiss = useCallback(() => {
    // An answer is stored on the instance and ends the ask for every admin, so
    // only a closing without one snoozes the ask in this browser.
    if (useSettingsStore.getState().telemetry?.enabled === null) {
      recordDismissal(localStorage, Date.now());
    }
    setOpen(false);
  }, []);

  if (!open) return null;

  return <HelloModal open onAnswer={onAnswer} onDismiss={onDismiss} preview={preview} />;
}
