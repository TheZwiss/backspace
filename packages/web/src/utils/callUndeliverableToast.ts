
import { translate } from '../i18n';/**
 * Builds a user-facing toast message from a `dm_call_undeliverable` event.
 *
 * Copy is phase-aware:
 * - `start`: call-start delivery; terminal means the ring was destroyed, non-terminal
 *   means the call continues for other reachable recipients.
 * - `accept`: the acceptor's B→host relay failed; terminal means their optimistic
 *   active-call state was rolled back.
 * - `reject`: the rejector's relay to the host failed; state was already cleared
 *   locally, so non-terminal info toast only.
 * - `end`: the ender's relay to the host failed; state was already cleared locally.
 * - `host_unreachable`: the call was terminated by the sentinel worker because the
 *   host peer became permanently unreachable. Always terminal. A single failure entry
 *   is expected; multiple fall back to a generic line.
 *
 * Extracted from `useWebSocket.ts` so it can be unit-tested without pulling in
 * the full WS handler graph (livekit / audio deps).
 */
export function buildCallUndeliverableToast(
  failures: Array<{ reason: string; peerOrigin?: string; peerLabel?: string }>,
  terminal: boolean,
  phase: 'start' | 'accept' | 'reject' | 'end' | 'host_unreachable' = 'start',
): string {
  const primary = failures[0];
  const labelFor = (f: { peerLabel?: string; peerOrigin?: string }) =>
    f.peerLabel ?? f.peerOrigin?.replace(/^https?:\/\//, '') ?? 'the remote instance';

  if (phase === 'accept' && terminal) {
    const label = primary ? labelFor(primary) : 'the host instance';
    return translate('runtime.manual.couldNotConfirmAccept', { label });
  }

  if (phase === 'reject') {
    const labels = failures.map(labelFor).join(', ') || 'the host instance';
    return translate('runtime.manual.couldNotNotifyDecline', { labels });
  }

  if (phase === 'end') {
    const labels = failures.map(labelFor).join(', ') || 'the host instance';
    return translate('runtime.manual.couldNotNotifyHangup', { labels });
  }

  // host_unreachable: call terminated because the host peer became unreachable.
  // Terminal is always true in this phase. A single failure entry is expected;
  // zero or multiple fall back to a generic line.
  if (phase === 'host_unreachable') {
    const [f] = failures;
    if (!f || failures.length !== 1) {
      return translate('runtime.selected.callUndeliverableToast.callEndedHostInstanceBecameUnreachable');
    }
    const label = f.peerLabel || f.peerOrigin?.replace(/^https?:\/\//, '') || 'the host instance';
    if (f.reason === 'peer_rejected') {
      return translate('runtime.manual.callEndedNoLongerPeered', { label });
    }
    return translate('runtime.manual.callEndedUnreachable', { label });
  }

  // phase === 'start' (default + legacy)
  if (!terminal) {
    const labels = failures.map(labelFor).join(', ');
    return translate('runtime.manual.someParticipantsUnreachable', { labels });
  }
  if (failures.length > 1) {
    const labels = failures.map(labelFor).join(', ');
    return translate('runtime.manual.couldNotReachInstances', { count: failures.length, labels });
  }
  if (!primary) return translate('runtime.selected.callUndeliverableToast.callCouldNotBePlaced');

  const label = labelFor(primary);
  switch (primary.reason) {
    case 'peer_rejected':
      return translate('runtime.manual.manualPeeringApprovalRequired', { label });
    case 'peer_awaiting_approval':
      return translate('runtime.manual.waitingForAdminApproval', { label });
    case 'peer_transient_failure':
      return translate('runtime.manual.couldNotReachLabel', { label });
    case 'livekit_unavailable':
      return translate('runtime.selected.callUndeliverableToast.voiceIsNotConfiguredOnThisInstance');
    case 'no_recipient':
      return translate('runtime.manual.couldNotRingAnyone', { label });
    default:
      return translate('runtime.manual.callCouldNotBePlacedTo', { label });
  }
}
