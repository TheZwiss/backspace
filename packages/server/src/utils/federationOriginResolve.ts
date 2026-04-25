import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { getOurOrigin } from './federationAuth.js';
import { validateOrigin } from '../routes/federation.js';

/**
 * Resolve a typed hostname (e.g., the part after `@` in `alice@orbit.test`)
 * into a full peer origin URL suitable for ensurePeered() / fetch().
 *
 * Resolution order:
 *   1. If a federation_peers row exists whose URL host matches (case-insensitive),
 *      return that peer's stored origin verbatim. (Authoritative for any peer the
 *      admin has explicitly configured.)
 *   2. Otherwise, mirror getOurOrigin()'s scheme:
 *        - https://...  →  https://${hostname}
 *        - http://...   →  http://${hostname}   (covers dev: localhost:3006)
 *      Validate via validateOrigin (which rejects http for non-localhost).
 *
 * Returns null if the result fails validation (e.g., http for a public domain
 * when our scheme is http — caller should surface as 'invalid target').
 *
 * Stale-scheme edge case: if a stored peer row points at the wrong scheme
 * (peer migrated http↔https since the row was written), ensurePeered will
 * surface a connectivity failure via the standard 'unreachable' path. Scheme
 * migration of an existing peer is an admin operation outside this code's
 * scope (delete + re-peer).
 */
export function resolveOriginFromHostname(hostnameOrHostPort: string): string | null {
  if (!hostnameOrHostPort) return null;
  const target = hostnameOrHostPort.trim().toLowerCase();
  if (!target) return null;

  const db = getDb();
  const peers = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .all();

  for (const p of peers) {
    try {
      const u = new URL(p.origin);
      if (u.host.toLowerCase() === target) return p.origin;
    } catch {
      // skip malformed origin
    }
  }

  const ourScheme = getOurOrigin().startsWith('https://') ? 'https://' : 'http://';
  const candidate = `${ourScheme}${target}`;
  return validateOrigin(candidate);
}
