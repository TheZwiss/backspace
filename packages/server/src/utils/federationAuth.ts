import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Generate a 256-bit random hex secret for HMAC signing.
 */
export function generateHmacSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Compute HMAC-SHA256 of `${timestamp}.${nonce}.${body}` (or `${timestamp}.${body}` when nonce
 * is absent, for backward compat with legacy peers) using the given secret.
 * Returns a hex-encoded signature string.
 */
export function signRequest(body: string, secret: string, timestamp: number, nonce: string | null = null): string {
  const payload = nonce ? `${timestamp}.${nonce}.${body}` : `${timestamp}.${body}`;
  return createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

/**
 * Verify a federation request signature.
 *
 * Returns true only if:
 *   - The timestamp is within maxAgeMs of Date.now()
 *   - The HMAC-SHA256 of `${timestamp}.${nonce}.${body}` (or `${timestamp}.${body}` when nonce
 *     is absent) matches the provided signature
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifySignature(
  body: string,
  signature: string,
  secret: string,
  timestamp: number,
  nonce: string | null = null,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): boolean {
  // Guard against empty or obviously invalid inputs
  if (!body && body !== '') return false;
  if (!signature || !secret) return false;

  // Validate timestamp is within the acceptable window
  const age = Math.abs(Date.now() - timestamp);
  if (age > maxAgeMs) return false;

  const expected = signRequest(body, secret, timestamp, nonce);

  // Convert both to Buffers for constant-time comparison
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');

  // timingSafeEqual requires identical lengths; mismatched lengths mean invalid
  if (expectedBuf.length !== actualBuf.length) return false;

  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Grace period during which both old and new secrets are accepted for verification. */
export const ROTATION_GRACE_PERIOD_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Verify a federation request signature against a peer's secrets.
 *
 * During secret rotation (when pendingHmacSecret is set and within the grace period),
 * accepts signatures made with either the primary or pending secret.
 */
export function verifyPeerSignature(
  body: string,
  signature: string,
  timestamp: number,
  nonce: string | null,
  peer: {
    hmacSecret: string;
    pendingHmacSecret: string | null;
    secretRotationAt: number | null;
  },
): boolean {
  // Try primary secret first
  if (verifySignature(body, signature, peer.hmacSecret, timestamp, nonce)) return true;

  // During grace period, try pending secret
  if (peer.pendingHmacSecret && peer.secretRotationAt) {
    const elapsed = Date.now() - peer.secretRotationAt;
    if (elapsed <= ROTATION_GRACE_PERIOD_MS) {
      return verifySignature(body, signature, peer.pendingHmacSecret, timestamp, nonce);
    }
  }

  return false;
}

/**
 * Build the HTTP headers required for an outbound federation request.
 *
 * Returned headers:
 *   X-Federation-Signature: sha256=<hmac-hex>
 *   X-Federation-Origin:    <origin>
 *   X-Federation-Timestamp: <unix-ms>
 *   X-Federation-Nonce:     <uuid-v4>
 *   Content-Type:           application/json
 */
export function buildFederationHeaders(
  body: string,
  secret: string,
  origin: string,
): Record<string, string> {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const sig = signRequest(body, secret, timestamp, nonce);

  return {
    'X-Federation-Signature': `sha256=${sig}`,
    'X-Federation-Origin': origin,
    'X-Federation-Timestamp': String(timestamp),
    'X-Federation-Nonce': nonce,
    'Content-Type': 'application/json',
  };
}

/**
 * Parse and validate the federation headers from an inbound request.
 *
 * Returns the extracted { origin, timestamp, signature, nonce } on success,
 * or null if any required header is missing or malformed.
 * `nonce` is null when the peer did not send X-Federation-Nonce (legacy peers).
 *
 * Signature header format: `sha256=<hex>`
 */
export function parseFederationHeaders(
  headers: Record<string, string | string[] | undefined>,
): { origin: string; timestamp: number; signature: string; nonce: string | null } | null {
  // Helper to extract a single string value from a potentially multi-value header
  const getHeader = (name: string): string | null => {
    const value = headers[name];
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) {
      return value.length > 0 ? (value[0] ?? null) : null;
    }
    return value;
  };

  const rawSignature = getHeader('x-federation-signature') ?? getHeader('X-Federation-Signature');
  const rawOrigin = getHeader('x-federation-origin') ?? getHeader('X-Federation-Origin');
  const rawTimestamp = getHeader('x-federation-timestamp') ?? getHeader('X-Federation-Timestamp');

  if (!rawSignature || !rawOrigin || !rawTimestamp) return null;

  // Signature must be in the format "sha256=<hex>"
  const sigPrefix = 'sha256=';
  if (!rawSignature.startsWith(sigPrefix)) return null;

  const signature = rawSignature.slice(sigPrefix.length);
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return null;

  const timestampMs = Number(rawTimestamp);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;

  const origin = rawOrigin.trim();
  if (!origin) return null;

  const rawNonce = getHeader('x-federation-nonce') ?? getHeader('X-Federation-Nonce');
  const nonce = rawNonce && typeof rawNonce === 'string' && rawNonce.trim() ? rawNonce.trim() : null;

  // Reject nonces that are unreasonably long (UUID v4 is 36 chars)
  if (nonce && nonce.length > 64) return null;

  return { origin, timestamp: timestampMs, signature, nonce };
}

/**
 * Return the canonical origin URL for this instance.
 *
 * Resolution order:
 *   1. `PUBLIC_ORIGIN` env (verbatim, trailing slash stripped) — overrides everything.
 *      Used by integration test harnesses that bind to 127.0.0.1:<ephemeral> and by
 *      reverse-proxy / dev-without-TLS setups where federation must advertise an
 *      explicit origin distinct from the public DOMAIN. The override is the URL
 *      transport layer; identity (homeInstance) still derives from DOMAIN.
 *   2. `https://${DOMAIN}` — production default.
 *   3. `http://localhost:${PORT}` — dev fallback when DOMAIN is unset.
 */
export function getOurOrigin(): string {
  const override = config.publicOrigin;
  if (override && override.trim()) {
    return override.trim().replace(/\/$/, '');
  }
  if (config.domain) {
    return `https://${config.domain}`;
  }
  return `http://localhost:${config.port}`;
}

/**
 * Canonicalize a homeInstance / origin value for comparison.
 *
 * The homeInstance column is stored in two shapes depending on the code path
 * that wrote it:
 *   - `auth.ts` registration writes the bare host the client sent (e.g. `nova.ddns.net`).
 *   - `resolveOrCreateReplicatedUser` writes the bare host (`extractDomain(...)`).
 *   - `getOurOrigin()` returns the full URL (`https://nova.ddns.net`).
 *
 * All federation authority / self-friend comparisons must route through this
 * helper to avoid false-fires across the dual storage convention. Returns the
 * lowercased host (with optional :port), no scheme, no trailing slash.
 *
 * NOTE: A federation-wide audit + canonical-storage migration is tracked
 * separately. This helper papers over the inconsistency at comparison sites.
 */
export function normalizeOriginForCompare(value: string | null | undefined): string | null {
  if (!value) return null;
  let s = value.trim();
  if (!s) return null;
  // Strip scheme if present
  s = s.replace(/^https?:\/\//i, '');
  // Strip trailing slashes
  s = s.replace(/\/+$/, '');
  if (!s) return null;
  return s.toLowerCase();
}

/**
 * Canonicalize a homeInstance value to a full origin URL
 * (e.g. `https://nova.ddns.net`) for storage on columns whose authority
 * checks compare against `sourceInstance` (which is always a full URL).
 *
 * Accepts bare host (`nova.ddns.net`), scheme-prefixed (`https://...`), or
 * `null` / empty / whitespace (returns `null`). `localhost`-style values keep
 * `http://` if already present; otherwise the canonical default is `https://`.
 *
 * Use this at every write site that persists `dm_channels.ownerHomeInstance`
 * so that S2S authority checks aren't broken by a bare-vs-full mismatch.
 * Read paths should still normalize via `normalizeOriginForCompare` for
 * defensive parity with legacy rows.
 */
export function canonicalizeHomeInstance(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = value.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    // Strip trailing slashes only — preserve the explicit scheme.
    return s.replace(/\/+$/, '');
  }
  return `https://${s.replace(/\/+$/, '')}`;
}
