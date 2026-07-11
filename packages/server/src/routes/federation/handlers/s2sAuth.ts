import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb, schema } from '../../../db/index.js';
import { parseFederationHeaders, verifyPeerSignature } from '../../../utils/federationAuth.js';
import { isNonceDuplicate } from '../rateLimits.js';

/** A `federation_peers` row, as returned by a `select().from(...).get()`. */
type FederationPeerRow = typeof schema.federationPeers.$inferSelect;

/**
 * A rate limiter for the auth preamble. `limited(key)` returns true once the key
 * (always `peer.origin` here) is at capacity. When `retryAfterSeconds` is set, a
 * `Retry-After` header carrying that value is added to the 429 response.
 */
export interface S2SRateLimiter {
  limited: (key: string) => boolean;
  retryAfterSeconds?: number;
}

export interface S2SAuthOptions {
  /** Run this limiter (keyed on `peer.origin`) BEFORE signature verification. */
  rateLimiter?: S2SRateLimiter;
  /**
   * When a request omits a nonce AND the peer has never advertised nonce
   * support, emit the legacy `console.warn`. Endpoints that historically logged
   * this pass `true`; those that stayed silent pass `false`/omit.
   */
  logMissingNonce?: boolean;
  /**
   * Optional suffix for the missing-nonce warning, appended as ` [${logContext}]`.
   * Preserves the per-endpoint log tag (`/sync` logged a ` [sync]` suffix; the
   * `/identity` and `/relay` handlers logged no suffix).
   */
  logContext?: string;
}

/**
 * Result of {@link authenticateS2SPeer}. On `ok: false` a reply has ALREADY been
 * sent — the caller MUST `return` immediately without touching `reply` again.
 */
export type S2SAuthResult =
  | { ok: true; peer: FederationPeerRow; nonce: string | null }
  | { ok: false };

/**
 * Shared inbound S2S-auth preamble for HMAC-signed federation endpoints.
 *
 * Runs, IN THIS EXACT ORDER, the boilerplate that six endpoints share verbatim:
 *   1. Parse federation headers — missing/malformed → 401.
 *   2. Resolve the peer by origin; require `status === 'active'` → else 403.
 *   3. (optional) Rate-limit on `peer.origin` — 429 (+ `Retry-After` when
 *      configured). Deliberately BEFORE signature verification so a flooded peer
 *      never costs an HMAC computation.
 *   4. Verify the HMAC signature (honours rotation grace) → 401 on failure.
 *   5. Nonce replay protection: present + duplicate → 409; absent while the peer
 *      advertises nonce support → 401; absent otherwise → pass (optionally warn).
 *
 * On success returns `{ ok: true, peer, nonce }`; the caller resumes with its
 * own body validation and side effects. On any rejection the reply is sent and
 * `{ ok: false }` is returned — the caller must `return` at once.
 *
 * ── INTENTIONAL NON-ADOPTERS (do NOT fold these into this helper) ─────────────
 * Three S2S endpoints deliberately keep bespoke auth because a load-bearing gate
 * differs; sharing this helper would silently flatten it:
 *   • `POST /api/federation/epoch` — gates on `status !== 'revoked'` (ANY
 *     non-revoked peer answers, so a needs_attention/unreachable peer can drive
 *     RECOVERY via the signed epoch round-trip), returns **400** (not 401) on
 *     missing headers, and runs **no** nonce check.
 *   • `POST /api/federation/peer/rotate` — active-only but runs **no** nonce
 *     check (a lone shape; the rotation body is the replay unit).
 *   • `POST /api/federation/peer/denied` — gates on `awaiting_approval` (404 on
 *     no peer row, 409 on wrong status) and verifies against a SYNTHETIC
 *     no-grace secret object; entirely different control flow.
 * Also out of scope: `/peer/accept`, `/peer/initiate`, `/peer/ensure`
 * (first-contact / JWT, not S2S-HMAC).
 */
export function authenticateS2SPeer(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: S2SAuthOptions = {},
): S2SAuthResult {
  const db = getDb();

  // 1. Parse and require federation headers.
  const fedHeaders = parseFederationHeaders(
    request.headers as Record<string, string | string[] | undefined>,
  );
  if (!fedHeaders) {
    reply.code(401).send({ error: 'Missing or malformed federation headers', statusCode: 401 });
    return { ok: false };
  }

  // 2. Resolve the peer by origin; require an active relationship.
  const peer = db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, fedHeaders.origin))
    .get();

  if (!peer || peer.status !== 'active') {
    reply.code(403).send({ error: 'Unknown or inactive peer', statusCode: 403 });
    return { ok: false };
  }

  // 3. Rate-limit BEFORE signature verification (avoid HMAC work on a flood).
  if (opts.rateLimiter && opts.rateLimiter.limited(peer.origin)) {
    reply.code(429);
    if (opts.rateLimiter.retryAfterSeconds !== undefined) {
      reply.header('Retry-After', String(opts.rateLimiter.retryAfterSeconds));
    }
    reply.send({ error: 'Rate limit exceeded', statusCode: 429 });
    return { ok: false };
  }

  // 4. Verify the HMAC signature over the exact serialized body.
  const bodyString = JSON.stringify(request.body);
  if (!verifyPeerSignature(bodyString, fedHeaders.signature, fedHeaders.timestamp, fedHeaders.nonce, peer)) {
    reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
    return { ok: false };
  }

  // 5. Nonce-based replay protection.
  if (fedHeaders.nonce) {
    if (isNonceDuplicate(peer.origin, fedHeaders.nonce)) {
      reply.code(409).send({ error: 'Duplicate nonce — possible replay', statusCode: 409 });
      return { ok: false };
    }
  } else if (peer.nonceSupported) {
    // Peer previously proved nonce support but this request omits one — reject.
    reply.code(401).send({ error: 'Nonce required — peer previously supported nonces', statusCode: 401 });
    return { ok: false };
  } else if (opts.logMissingNonce) {
    const suffix = opts.logContext ? ` [${opts.logContext}]` : '';
    console.warn(`[federation] Peer ${peer.origin} does not support replay protection (no nonce)${suffix}`);
  }

  return { ok: true, peer, nonce: fedHeaders.nonce };
}
