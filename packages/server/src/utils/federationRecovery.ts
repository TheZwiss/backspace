import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { onPeerActivated } from './federationPeerActivation.js';

/** Reachability-probe timeout (ms). */
export const RECOVERY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Liveness probe shared by the recovery tick and the manual recheck endpoint.
 * GET {origin}/api/instance/info with a 10s timeout. No HMAC — reachability is
 * not trust; a recovered-but-HMAC-broken peer still transitions to
 * needs_attention via the auth-failure path on the next real delivery.
 */
export async function probePeerReachable(origin: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const timeout = AbortSignal.timeout(RECOVERY_PROBE_TIMEOUT_MS);
    const response = await fetch(`${origin}/api/instance/info`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Transition an unreachable peer back to active and reset recovery pacing.
 * onPeerActivated broadcasts federation_peers_changed to admins. Rotation fields
 * are intentionally untouched — recovery is orthogonal to rotation.
 */
export async function markPeerRecovered(peerId: string): Promise<void> {
  const db = getDb();
  db.update(schema.federationPeers)
    .set({
      status: 'active',
      consecutiveFailures: 0,
      lastSeenAt: Date.now(),
      probeAttempts: 0,
      lastProbeAt: null,
    })
    .where(eq(schema.federationPeers.id, peerId))
    .run();
  await onPeerActivated(peerId, 'health_check_recovery');
}
