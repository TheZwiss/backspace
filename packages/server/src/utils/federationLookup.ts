import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { buildFederationHeaders, getOurOrigin } from './federationAuth.js';
import type { FederationUserLookupProfile, FederationUserLookupResponse } from '@backspace/shared';

const LOOKUP_TIMEOUT_MS = 10_000;

export type LookupResult =
  | { ok: true; homeUserId: string; username: string; profile: FederationUserLookupProfile }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'unreachable' }
  | { ok: false; reason: 'rate_limited'; retryAfter?: number };

/**
 * Look up a username on a remote peer instance.
 *
 * - Looks up the peer's HMAC secret from the local federation_peers table.
 * - Throws if the peer record is missing — caller must ensurePeered first.
 * - Wraps fetch in a 10s timeout; network/timeout/AbortError → unreachable.
 * - HTTP 404 → not_found; 429 → rate_limited (with retryAfter); 200 + valid body → ok;
 *   anything else (5xx, unexpected 4xx, malformed body) → throws (logged at call site).
 */
export async function lookupRemoteUser(peerOrigin: string, username: string): Promise<LookupResult> {
  const db = getDb();
  const peer = db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, peerOrigin))
    .get();

  if (!peer) {
    throw new Error(`lookupRemoteUser: no peer record for ${peerOrigin}`);
  }

  const body = JSON.stringify({ username });
  const headers = buildFederationHeaders(body, peer.hmacSecret, getOurOrigin());

  let response: Response;
  try {
    response = await fetch(`${peerOrigin}/api/federation/users/lookup`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    // Network error, timeout, AbortError — all unreachable.
    return { ok: false, reason: 'unreachable' };
  }

  if (response.status === 404) {
    return { ok: false, reason: 'not_found' };
  }

  if (response.status === 429) {
    const raw = Number(response.headers.get('Retry-After') ?? '60');
    const retryAfter = Number.isFinite(raw) ? raw : 60;
    return { ok: false, reason: 'rate_limited', retryAfter };
  }

  if (!response.ok) {
    throw new Error(`lookupRemoteUser: peer ${peerOrigin} returned HTTP ${response.status}`);
  }

  const json = (await response.json()) as FederationUserLookupResponse;
  if (!json || json.found !== true || !json.user || typeof json.user.homeUserId !== 'string') {
    throw new Error(`lookupRemoteUser: peer ${peerOrigin} returned malformed body`);
  }

  return {
    ok: true,
    homeUserId: json.user.homeUserId,
    username: json.user.username,
    profile: json.user.profile,
  };
}
