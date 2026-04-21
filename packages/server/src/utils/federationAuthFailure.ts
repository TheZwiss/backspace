/**
 * Number of consecutive 401/403 responses from an active peer before the
 * outbox worker transitions that peer to `needs_attention`.
 *
 * Rationale (see design spec §Retry Budget): with the existing
 * BACKOFF_SCHEDULE_MS = [30s, 1m, 5m, 15m, 1h], five consecutive auth
 * failures span ~21.5 min — covering the 15-min rotation grace window
 * with ~6.5 min margin while still giving clear signal that a persistent
 * desync has occurred.
 */
export const AUTH_FAILURE_THRESHOLD = 5;

export type AuthFailureAction =
  | { kind: 'backoff'; newAuthFailures: number }
  | { kind: 'transition_to_needs_attention'; newAuthFailures: number };

/**
 * Pure decision function. Given the current consecutive-auth-failure count,
 * return whether the next failure keeps the peer in retry-with-backoff or
 * transitions it to the `needs_attention` terminal state.
 */
export function evaluateAuthFailure(currentAuthFailures: number): AuthFailureAction {
  const newAuthFailures = currentAuthFailures + 1;
  if (newAuthFailures >= AUTH_FAILURE_THRESHOLD) {
    return { kind: 'transition_to_needs_attention', newAuthFailures };
  }
  return { kind: 'backoff', newAuthFailures };
}
