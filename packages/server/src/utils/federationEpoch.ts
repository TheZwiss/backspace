import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { buildFederationHeaders, verifySignature, getOurOrigin } from './federationAuth.js';

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
 * Fetch a peer's authenticated instance epoch via `POST /api/federation/epoch`.
 *
 * The request is HMAC-signed with the shared secret (so only an established
 * peer can make the call), and the peer's response body is HMAC-verified with
 * the same secret before its value is trusted — a poisoned baseline can drive a
 * spurious heal on a live peer (design §9), so the epoch we newly trust is
 * signed, not TLS-only.
 *
 * Fails safe: any failure — a 404 from a not-yet-upgraded peer, a bad/absent
 * response signature, or a network/timeout error — returns `null`. Callers
 * treat `null` as "retry on the next tick," never as an error to surface. No
 * exception escapes this function.
 */
export async function fetchPeerEpoch(peer: PeerForEpoch): Promise<string | null> {
  const body = JSON.stringify({});
  const headers = buildFederationHeaders(body, peer.hmacSecret, getOurOrigin());

  let res: Response;
  try {
    res = await fetch(`${peer.origin}/api/federation/epoch`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Network error / timeout — benign no-op, retry later.
    return null;
  }

  // 404 = peer not yet upgraded (endpoint absent); any other non-2xx = error.
  if (res.status === 404 || !res.ok) return null;

  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }

  // Verify the response signature with the SAME secret and arg order the peer's
  // handler signed it with. A mismatch means we must not trust the value.
  const sig = (res.headers.get('x-federation-signature') ?? '').replace(/^sha256=/, '');
  const ts = Number(res.headers.get('x-federation-timestamp'));
  const nonce = res.headers.get('x-federation-nonce');
  if (!sig || !Number.isFinite(ts) || !verifySignature(text, sig, peer.hmacSecret, ts, nonce)) {
    return null;
  }

  try {
    return (JSON.parse(text) as { instanceId?: string }).instanceId ?? null;
  } catch {
    return null;
  }
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
