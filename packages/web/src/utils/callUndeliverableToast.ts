/**
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
 *
 * Extracted from `useWebSocket.ts` so it can be unit-tested without pulling in
 * the full WS handler graph (livekit / audio deps).
 */
export function buildCallUndeliverableToast(
  failures: Array<{ reason: string; peerOrigin?: string; peerLabel?: string }>,
  terminal: boolean,
  phase: 'start' | 'accept' | 'reject' | 'end' = 'start',
): string {
  const primary = failures[0];
  const labelFor = (f: { peerLabel?: string; peerOrigin?: string }) =>
    f.peerLabel ?? f.peerOrigin?.replace(/^https?:\/\//, '') ?? 'the remote instance';

  if (phase === 'accept' && terminal) {
    const label = primary ? labelFor(primary) : 'the host instance';
    return `Couldn't confirm your accept with ${label} — the call was dropped.`;
  }

  if (phase === 'reject') {
    const labels = failures.map(labelFor).join(', ') || 'the host instance';
    return `Couldn't notify ${labels} that you declined. Caller may still see you as ringing briefly.`;
  }

  if (phase === 'end') {
    const labels = failures.map(labelFor).join(', ') || 'the host instance';
    return `Couldn't notify ${labels} that you hung up. Remote participants may see the call for up to 60 seconds.`;
  }

  // phase === 'start' (default + legacy)
  if (!terminal) {
    const labels = failures.map(labelFor).join(', ');
    return `Some participants could not be reached: ${labels}.`;
  }
  if (failures.length > 1) {
    const labels = failures.map(labelFor).join(', ');
    return `Could not reach ${failures.length} instances: ${labels}.`;
  }
  if (!primary) return 'Call could not be placed.';

  const label = labelFor(primary);
  switch (primary.reason) {
    case 'peer_rejected':
      return `Cannot reach ${label} — this instance requires manual peering approval.`;
    case 'peer_awaiting_approval':
      return `Waiting for ${label} admin to approve your instance. Calls will work once approved.`;
    case 'peer_transient_failure':
      return `Could not reach ${label}. Try again in a moment.`;
    case 'livekit_unavailable':
      return 'Voice is not configured on this instance.';
    default:
      return `Call to ${label} could not be placed.`;
  }
}
