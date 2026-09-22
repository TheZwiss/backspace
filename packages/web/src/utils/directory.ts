import type { DirectoryEntry } from '@backspace/shared';

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

/**
 * Outer Space is deduped by origin, not by space: every entry whose origin
 * is one the session already has a connection to (the home instance or any
 * entry of `instanceStore.instances`, whatever its status) is dropped, since
 * those spaces belong to Inner Space. A connected value that does not parse
 * is skipped; an entry whose own origin does not parse is kept.
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
