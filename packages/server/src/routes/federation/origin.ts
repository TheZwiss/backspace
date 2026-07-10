import { schema } from '../../db/index.js';
import { getOurOrigin } from '../../utils/federationAuth.js';
import { or } from 'drizzle-orm';

/** Fields safe to expose to admin callers (everything except hmacSecret). */
export interface SanitizedPeer {
  id: string;
  origin: string;
  instanceName: string | null;
  status: string;
  lastSeenAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  lastSyncedAt: number | null;
  createdAt: number;
  rotationInProgress: boolean;
  secretRotatedAt: number | null;
  autoRotateIntervalDays: number;
  needsAttentionReason: 'auth_failures' | 'peer_reset_detected' | 'repeer_incomplete' | null;
}


export function sanitizePeer(row: typeof schema.federationPeers.$inferSelect): SanitizedPeer {
  return {
    id: row.id,
    origin: row.origin,
    instanceName: row.instanceName,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    lastFailureAt: row.lastFailureAt,
    consecutiveFailures: row.consecutiveFailures,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    rotationInProgress: row.pendingHmacSecret !== null,
    secretRotatedAt: row.secretRotatedAt,
    autoRotateIntervalDays: row.autoRotateIntervalDays,
    needsAttentionReason: row.needsAttentionReason as SanitizedPeer['needsAttentionReason'],
  };
}


/**
 * Determine this instance's public origin for the peering handshake.
 *
 * Delegates to `getOurOrigin()` so the handshake `sourceOrigin` is IDENTICAL to
 * the `X-Federation-Origin` value used for authenticated S2S requests. This
 * honors `PUBLIC_ORIGIN` (getOurOrigin's precedence: PUBLIC_ORIGIN →
 * `https://${DOMAIN}` → `http://localhost:${PORT}`). Using DOMAIN directly here
 * previously desynced the responder's peer-row key from the auth origin,
 * causing permanent `403 Not peered` whenever PUBLIC_ORIGIN != https://DOMAIN.
 */
export function resolveLocalOrigin(): string {
  return getOurOrigin();
}


/**
 * Validate that a string is a well-formed HTTP(S) URL origin.
 * Returns the normalized origin (no trailing slash) or null if invalid.
 */
export function validateOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
