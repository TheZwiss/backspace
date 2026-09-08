import { useSettingsStore } from '../stores/settingsStore';
import { shouldBadgeUpdate } from '../utils/updateAck';

/**
 * Whether to show the "an instance update is available" dot.
 *
 * Read-only: it starts no request and owns no timer. The fetch belongs to
 * `settingsStore`, driven by the home WebSocket's `ready` event, so mounting
 * this in several places costs nothing.
 *
 * Always the home instance. Connected remote instances are never consulted —
 * Instance settings administer the instance that served this client, the same
 * way the telemetry panel does.
 */
export function useInstanceUpdateBadge(): boolean {
  const status = useSettingsStore((s) => s.updateStatus);
  const ack = useSettingsStore((s) => s.updateAck);
  const isAdmin = useSettingsStore((s) => s.isAdmin);
  return shouldBadgeUpdate(status, ack, isAdmin);
}
