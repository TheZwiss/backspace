import type { DirectoryEntry, FederationRegistryEntry } from '@backspace/shared';

/**
 * Canonical origin of a value (`new URL(x).origin`), or null when it does not
 * parse. Origins are compared this way on both sides so that a trailing
 * slash, a path or a differently cased host never defeat the match.
 */
function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The two fields of a live `ConnectedInstance` the origin rule reads. */
export interface LiveInstanceStatus {
  origin: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
}

/**
 * The origins that belong to Inner Space, so their directory entries are
 * dropped from Outer Space: a registry entry that is `connected`, or in one
 * of the two fault states whose chip explains the absence (`auth_expired`,
 * `unreachable`), and a live instance that is `connected` or `connecting`.
 * A `disconnected` registry entry is the user's own choice and does not
 * qualify: for Explore that instance is an outer instance again, its spaces
 * ordinary cards, and connecting from one reuses the identity the session
 * still holds. A live instance in `error` or `disconnected` with no registry
 * standing of its own does not qualify either. The home origin is added by
 * the caller. Each origin is listed once, as the store spells it.
 */
export function innerOrigins(
  registry: Iterable<FederationRegistryEntry>,
  instances: Iterable<LiveInstanceStatus>,
): string[] {
  const out = new Set<string>();
  for (const entry of registry) {
    if (entry.status === 'connected' || entry.status === 'auth_expired' || entry.status === 'unreachable') {
      out.add(entry.origin);
    }
  }
  for (const live of instances) {
    if (live.status === 'connected' || live.status === 'connecting') out.add(live.origin);
  }
  return Array.from(out);
}

/**
 * Outer Space is deduped by origin, not by space: every entry whose origin
 * is one of `connectedOrigins` (the home instance plus `innerOrigins`) is
 * dropped, since those spaces belong to Inner Space or are accounted for by
 * a connection chip. A connected value that does not parse is skipped; an
 * entry whose own origin does not parse is kept.
 */
export function dedupeAgainstConnected(entries: DirectoryEntry[], connectedOrigins: string[]): DirectoryEntry[] {
  const connected = new Set<string>();
  for (const value of connectedOrigins) {
    const origin = canonicalOrigin(value);
    if (origin) connected.add(origin);
  }
  if (connected.size === 0) return entries;
  return entries.filter((entry) => {
    const origin = canonicalOrigin(entry.origin);
    return origin === null || !connected.has(origin);
  });
}

/**
 * Whether an unknown value (a modal's `modalData` slot, say) is a directory
 * entry: the fields the connect-and-join flow reads must be present with the
 * right types. Optional presentation fields are not checked.
 */
export function isDirectoryEntry(value: unknown): value is DirectoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.origin === 'string' &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    (v.visibility === 'public' || v.visibility === 'request')
  );
}
