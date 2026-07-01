import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { onPeerActivated } from './federationPeerActivation.js';
import { markPeerReset } from './federationReset.js';

/** Reachability-probe timeout (ms). */
export const RECOVERY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Result of a reachability probe. `instanceId` is the peer's advertised instance
 * epoch (from `/api/instance/info`), used for reset detection. It is `null` when
 * the peer is unreachable, when it is too old to advertise an epoch, or when the
 * body is unparseable — all of which degrade to "no reset observed."
 */
export interface ProbeResult {
  reachable: boolean;
  instanceId: string | null;
}

/**
 * Liveness probe shared by the recovery tick and the manual recheck endpoint.
 * GET {origin}/api/instance/info with a 10s timeout. No HMAC — reachability is
 * not trust; a recovered-but-HMAC-broken peer still transitions to
 * needs_attention via the auth-failure path on the next real delivery.
 *
 * Also parses the peer's advertised `instanceId` (instance epoch) from the
 * response so callers can detect a wipe-and-reinstall (a NEW incarnation on the
 * same domain). A missing/unparseable epoch is reported as `null` — never an
 * error — so a legacy peer that omits it simply recovers normally.
 */
export async function probePeerReachable(origin: string, signal?: AbortSignal): Promise<ProbeResult> {
  try {
    const timeout = AbortSignal.timeout(RECOVERY_PROBE_TIMEOUT_MS);
    const response = await fetch(`${origin}/api/instance/info`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      return { reachable: false, instanceId: null };
    }
    let instanceId: string | null = null;
    try {
      const body = (await response.json()) as { instanceId?: unknown };
      if (typeof body?.instanceId === 'string' && body.instanceId.length > 0) {
        instanceId = body.instanceId;
      }
    } catch {
      // Reachable but body unparseable — treat epoch as unknown, not a failure.
      instanceId = null;
    }
    return { reachable: true, instanceId };
  } catch {
    return { reachable: false, instanceId: null };
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

/**
 * Decide the outcome of a successful reachability probe for a peer that is
 * eligible to recover. This is the single recovery-decision point shared by the
 * background recovery worker and the manual recheck endpoint.
 *
 * Detection-only reset gate: if the peer has a trusted baseline epoch
 * (`peer_instance_id`) AND the probe observed a DIFFERENT epoch, the peer is a
 * new incarnation on the same domain. A genuinely reset peer's HMAC secret is
 * desynced, so flipping it back to `active` via a reachability probe would
 * resume relay against a dead secret. We therefore route it to
 * `needs_attention` via `markPeerReset` and DO NOT recover it — it must wait for
 * an admin-authenticated re-handshake. Only when the epoch matches the baseline
 * (or the baseline is null / the epoch is unknown) does the normal recovery path
 * run.
 *
 * @returns `'reset_detected'` if the peer was routed to needs_attention;
 *          `'recovered'` if it was flipped back to active.
 */
export async function recoverOrDetectReset(
  peer: { id: string; origin: string; peerInstanceId: string | null },
  result: ProbeResult,
): Promise<'recovered' | 'reset_detected'> {
  if (peer.peerInstanceId && result.instanceId && result.instanceId !== peer.peerInstanceId) {
    markPeerReset(peer.id, peer.origin, peer.peerInstanceId, result.instanceId);
    return 'reset_detected';
  }
  await markPeerRecovered(peer.id);
  return 'recovered';
}
