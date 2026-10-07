import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { buildFederationHeaders, verifySignature, getOurOrigin } from './federationAuth.js';
import { federationFetch } from './federationFetch.js';

let cached: string | null = null;

/** This instance's persistent epoch (incarnation UUID). Set by ensureDefaults on boot. */
export function getInstanceId(): string {
  if (cached) return cached;
  const db = getDb();
  const row = db.select({ instanceId: schema.instanceSettings.instanceId })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.id, 1))
    .get();
  if (!row?.instanceId) {
    throw new Error('instance_id is not set — ensureDefaults must run before getInstanceId');
  }
  cached = row.instanceId;
  return cached;
}

/** Test-only: clear the module cache between cases. */
export function __resetInstanceIdCacheForTest(): void {
  cached = null;
}

/** The minimal peer shape `fetchPeerEpoch` needs: its origin and our shared secret with it. */
export interface PeerForEpoch {
  origin: string;
  hmacSecret: string;
}

/**
 * What a signed `POST /api/federation/epoch` round-trip says about the secret
 * it was signed with:
 *
 * - `verified`: the peer holds this secret (it verified our request and its
 *   signed answer verifies with the same secret). Carries the peer's epoch.
 * - `not_peered`: the peer answered 403, so it holds no row for us, or has
 *   revoked it. A handshake can reach a fresh slot there.
 * - `secret_mismatch`: the peer answered 401, so it holds a row for us under a
 *   different secret.
 * - `unknown`: anything else (network error, timeout, 404 from a build without
 *   the endpoint, 5xx, an answer whose signature does not verify).
 *
 * Every released Backspace version serves `/api/federation/epoch` (it shipped
 * before v1.0.0), and the endpoint answers any peer row that is not revoked.
 */
export type EpochProbe =
  | { kind: 'verified'; instanceId: string }
  | { kind: 'not_peered' }
  | { kind: 'secret_mismatch' }
  | { kind: 'unknown' };

/**
 * Sign an epoch request with `peer.hmacSecret` and classify the answer (see
 * EpochProbe). The response body is HMAC-verified with the same secret before
 * its value is trusted: a poisoned baseline can drive a spurious heal on a
 * live peer (design §9), so the epoch we newly trust is signed, not TLS-only.
 * No exception escapes this function.
 */
export async function probeEpoch(peer: PeerForEpoch): Promise<EpochProbe> {
  const body = JSON.stringify({});
  const headers = buildFederationHeaders(body, peer.hmacSecret, getOurOrigin());

  let res: Response;
  try {
    res = await federationFetch(peer.origin, '/api/federation/epoch', {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    }, 'approved');
  } catch {
    return { kind: 'unknown' };
  }

  if (res.status === 403) return { kind: 'not_peered' };
  if (res.status === 401) return { kind: 'secret_mismatch' };
  if (!res.ok) return { kind: 'unknown' };

  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: 'unknown' };
  }

  // Verify the response signature with the SAME secret and arg order the peer's
  // handler signed it with. A mismatch means we must not trust the value.
  const sig = (res.headers.get('x-federation-signature') ?? '').replace(/^sha256=/, '');
  const ts = Number(res.headers.get('x-federation-timestamp'));
  const nonce = res.headers.get('x-federation-nonce');
  if (!sig || !Number.isFinite(ts) || !verifySignature(text, sig, peer.hmacSecret, ts, nonce)) {
    return { kind: 'unknown' };
  }

  try {
    const instanceId = (JSON.parse(text) as { instanceId?: unknown }).instanceId;
    return typeof instanceId === 'string' && instanceId.length > 0
      ? { kind: 'verified', instanceId }
      : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * The peer's authenticated instance epoch, or `null` when `probeEpoch` could
 * not verify one. Callers treat `null` as "retry on the next tick," never as
 * an error to surface.
 */
export async function fetchPeerEpoch(peer: PeerForEpoch): Promise<string | null> {
  const probe = await probeEpoch(peer);
  return probe.kind === 'verified' ? probe.instanceId : null;
}

/**
 * Deterministic baseline populator: for each `active` peer whose
 * `peer_instance_id` is still NULL, fetch its authenticated epoch once and store
 * it. This is the load-bearing guarantee (design §3.2) — it populates the
 * trusted baseline within one refresh cycle of an upgrade, independent of any
 * user/relay activity, closing the window that relay-only population leaves for
 * idle peers.
 *
 * Populate-if-null ONLY: the `UPDATE ... WHERE peer_instance_id IS NULL` guard
 * makes it structurally impossible to overwrite a baseline that another path
 * (relay, handshake) already established. Self-terminating: once a peer's
 * `peer_instance_id` is set, the `isNull` filter excludes it, so it is never
 * fetched again.
 *
 * Staggered-rollout tolerant: `fetchPeerEpoch` returns `null` for a 404
 * (not-yet-upgraded peer), a bad/absent response signature, or a network error.
 * All of those are benign no-ops — we simply skip the peer and retry on the next
 * tick, with no error log-spam. No exception escapes this function.
 */
export async function refreshPeerEpochs(): Promise<void> {
  const db = getDb();
  const peers = db
    .select({
      id: schema.federationPeers.id,
      origin: schema.federationPeers.origin,
      hmacSecret: schema.federationPeers.hmacSecret,
    })
    .from(schema.federationPeers)
    .where(and(
      eq(schema.federationPeers.status, 'active'),
      isNull(schema.federationPeers.peerInstanceId),
    ))
    .all();

  for (const peer of peers) {
    const epoch = await fetchPeerEpoch(peer);
    if (!epoch) continue; // 404 / bad-sig / network → retry next tick, no log-spam.

    // Populate-if-null only: the IS NULL guard never overwrites a non-null baseline.
    db.update(schema.federationPeers)
      .set({ peerInstanceId: epoch })
      .where(and(
        eq(schema.federationPeers.id, peer.id),
        isNull(schema.federationPeers.peerInstanceId),
      ))
      .run();
  }
}
