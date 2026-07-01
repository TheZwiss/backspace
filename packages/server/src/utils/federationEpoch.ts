import { eq } from 'drizzle-orm';
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
