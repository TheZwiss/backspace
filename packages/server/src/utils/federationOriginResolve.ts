import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { getOurOrigin } from './federationAuth.js';
import { validateOrigin } from '../routes/federation.js';

/**
 * Resolve a hostname (the part after `@` in `alice@orbit.test`, or the domain
 * of a federated identity) into a full peer origin URL suitable for
 * ensurePeered() / fetch().
 *
 * Resolution order:
 *   1. A federation_peers row whose URL host (hostname and port) matches,
 *      case-insensitively: that peer's stored origin verbatim. (Authoritative
 *      for any peer the admin has explicitly configured.)
 *   2. For a target without a port, the one `active` peer row on that
 *      hostname, when there is exactly one. An identity domain is a bare
 *      hostname (`extractDomain` drops the port), while the peer row is keyed
 *      by the origin the peer advertises, which carries the port when the peer
 *      has one in DOMAIN or in PUBLIC_ORIGIN. Only an active row counts: a row
 *      left from a former ported setup (unreachable, needs_attention, rejected)
 *      must not keep the hostname from reaching the peer's current origin in
 *      step 3. Two active peers that differ only by port cannot be told apart
 *      by a hostname, so none of them is picked.
 *   3. Otherwise, mirror getOurOrigin()'s scheme:
 *        - https://...  →  https://${hostname}
 *        - http://...   →  http://${hostname}   (covers dev: localhost:3006)
 *      Validate via validateOrigin (which rejects http for non-localhost).
 *
 * Returns null if the result fails validation (e.g., http for a public domain
 * when our scheme is http — caller should surface as 'invalid target').
 *
 * An identity domain that is not the host of the peer's advertised origin
 * (PUBLIC_ORIGIN on another hostname than DOMAIN) does not resolve to that
 * peer: this instance does not know a peer's DOMAIN.
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
    .select({ origin: schema.federationPeers.origin, status: schema.federationPeers.status })
    .from(schema.federationPeers)
    .all();

  const activeOnHostname: string[] = [];
  for (const p of peers) {
    let u: URL;
    try {
      u = new URL(p.origin);
    } catch {
      continue; // skip malformed origin
    }
    if (u.host.toLowerCase() === target) return p.origin;
    if (p.status === 'active' && u.hostname.toLowerCase() === target) activeOnHostname.push(p.origin);
  }
  if (activeOnHostname.length === 1 && !hasPort(target)) return activeOnHostname[0]!;

  const ourScheme = getOurOrigin().startsWith('https://') ? 'https://' : 'http://';
  const candidate = `${ourScheme}${target}`;
  return validateOrigin(candidate);
}

/** Whether a `host` or `host:port` string names a port (`[::1]:3000` included). */
function hasPort(hostOrHostPort: string): boolean {
  return /:\d+$/.test(hostOrHostPort);
}
