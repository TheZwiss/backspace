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
    // Any non-2xx that isn't 404 (not_found) or 429 (rate_limited) — e.g. 403
    // (peer rejects our HMAC: revoked, not-yet-active, or a post-reset secret
    // desync) or 5xx (peer error) — is treated as `unreachable`, NOT thrown.
    // A peer's auth/transport failure must never surface as an unhandled 500 on
    // a user action (e.g. a federated friend-add); callers already map
    // `unreachable` to a graceful 503. Logged for operators.
    console.warn(`[federation] lookupRemoteUser: peer ${peerOrigin} returned HTTP ${response.status} — treating as unreachable`);
    return { ok: false, reason: 'unreachable' };
  }

  const json = (await response.json().catch(() => null)) as FederationUserLookupResponse | null;
  if (!json || json.found !== true || !json.user || typeof json.user.homeUserId !== 'string') {
    // A malformed / non-JSON 200 body is peer misbehavior — surface as
    // unreachable rather than throwing (same reasoning as above).
    console.warn(`[federation] lookupRemoteUser: peer ${peerOrigin} returned malformed body — treating as unreachable`);
    return { ok: false, reason: 'unreachable' };
  }

  return {
    ok: true,
    homeUserId: json.user.homeUserId,
    username: json.user.username,
    profile: json.user.profile,
  };
}

/**
 * Reverse-lookup: ask the peer for a user by homeUserId. Used by the stub
 * backfill worker to translate legacy snowflake-named stubs into realname-named
 * stubs. Mirrors lookupRemoteUser's auth + error semantics.
 *
 * `not_found` here means "the peer does not host a native non-deleted user
 * with that homeUserId" — including the tombstone case. Caller should leave
 * the local stub untouched and retry on the next peer activation.
 */
export async function lookupRemoteUserByHomeId(peerOrigin: string, homeUserId: string): Promise<LookupResult> {
  const db = getDb();
  const peer = db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, peerOrigin))
    .get();

  if (!peer) {
    throw new Error(`lookupRemoteUserByHomeId: no peer record for ${peerOrigin}`);
  }

  const body = JSON.stringify({ homeUserId });
  const headers = buildFederationHeaders(body, peer.hmacSecret, getOurOrigin());

  let response: Response;
  try {
    response = await fetch(`${peerOrigin}/api/federation/users/by-home-id`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  if (response.status === 429) {
    const raw = Number(response.headers.get('Retry-After') ?? '60');
    const retryAfter = Number.isFinite(raw) ? raw : 60;
    return { ok: false, reason: 'rate_limited', retryAfter };
  }

  if (!response.ok) {
    throw new Error(`lookupRemoteUserByHomeId: peer ${peerOrigin} returned HTTP ${response.status}`);
  }

  const json = (await response.json()) as FederationUserLookupResponse;
  if (!json) {
    throw new Error(`lookupRemoteUserByHomeId: peer ${peerOrigin} returned empty body`);
  }
  if (json.found !== true || !json.user || typeof json.user.homeUserId !== 'string') {
    return { ok: false, reason: 'not_found' };
  }

  return {
    ok: true,
    homeUserId: json.user.homeUserId,
    username: json.user.username,
    profile: json.user.profile,
  };
}
