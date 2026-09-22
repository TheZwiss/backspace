import type Database from 'better-sqlite3';
import type { DirectoryPingError } from '@backspace/shared';

export interface DirectoryState {
  enabled: boolean;
  dirty: boolean;
  lastPingAt: number | null;
  lastError: DirectoryPingError | null;
}

interface Row {
  directory_enabled: number;
  directory_dirty: number;
  directory_last_ping_at: number | null;
  directory_last_error: string | null;
}

/**
 * In-memory generation of the served document. Bumped by every
 * markDirectoryDirty. Not persisted on purpose: a restart sends a boot ping
 * whenever the flag is set, so a counter that starts over cannot clear a
 * stale flag (section 4 of the spec).
 */
let documentVersion = 0;
const listeners = new Set<() => void>();

export type DirectoryPingReason = NonNullable<DirectoryPingError['reason']>;

const STATUSES = new Set(['network', 'timeout', 'origin', 'fetch']);
const REASONS: ReadonlySet<string> = new Set<DirectoryPingReason>(['unreachable', 'status', 'invalid', 'origin-mismatch']);

/** True for a reason the hub may send with a 502, and that the wire type admits. */
export function isDirectoryPingReason(value: unknown): value is DirectoryPingReason {
  return typeof value === 'string' && REASONS.has(value);
}

function parseError(raw: string | null): DirectoryPingError | null {
  if (raw === null) return null;
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) return null;
    const { at, status, reason } = p as { at?: unknown; status?: unknown; reason?: unknown };
    if (typeof at !== 'number') return null;
    const statusOk = typeof status === 'number' || (typeof status === 'string' && STATUSES.has(status));
    if (!statusOk) return null;
    const out: DirectoryPingError = { at, status: status as DirectoryPingError['status'] };
    if (isDirectoryPingReason(reason)) out.reason = reason;
    return out;
  } catch {
    return null;
  }
}

export function readDirectoryState(sqlite: Database.Database): DirectoryState {
  const row = sqlite.prepare(
    'SELECT directory_enabled, directory_dirty, directory_last_ping_at, directory_last_error FROM instance_settings WHERE id = 1',
  ).get() as Row | undefined;
  if (!row) return { enabled: false, dirty: false, lastPingAt: null, lastError: null };
  return {
    enabled: row.directory_enabled === 1,
    dirty: row.directory_dirty === 1,
    lastPingAt: row.directory_last_ping_at,
    lastError: parseError(row.directory_last_error),
  };
}

/**
 * Whether people on this instance browse the directory: the incoming half of
 * the feature, and the admin's own switch. The outgoing half (what this
 * instance lists) is `DirectoryState.enabled` above, and the two never gate
 * each other.
 *
 * The one place the column is read, so the proxy route and the public
 * instance info can never disagree about what it means. A missing settings
 * row reads as off, the same way `readDirectoryState` treats one.
 */
export function readDirectoryBrowseEnabled(sqlite: Database.Database): boolean {
  const row = sqlite.prepare(
    'SELECT directory_browse_enabled FROM instance_settings WHERE id = 1',
  ).get() as { directory_browse_enabled: number } | undefined;
  return row?.directory_browse_enabled === 1;
}

export function getDocumentVersion(): number {
  return documentVersion;
}

/** Subscribe to dirty marks. The pinger's debounce hangs off this. */
export function onDirectoryDirty(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The one call every change to the served document goes through. Persists
 * the flag, moves the version (which also invalidates the endpoint cache,
 * keyed on it), then tells the pinger.
 */
export function markDirectoryDirty(sqlite: Database.Database): void {
  sqlite.prepare('UPDATE instance_settings SET directory_dirty = 1 WHERE id = 1').run();
  documentVersion += 1;
  for (const l of listeners) l();
}

/** Clears the flag only if the document is still the one the ping was sent for. */
export function recordDirectoryPingSuccess(sqlite: Database.Database, sentVersion: number, at: number): boolean {
  const unchanged = sentVersion === documentVersion;
  sqlite.prepare(
    `UPDATE instance_settings SET directory_last_ping_at = ?, directory_last_error = NULL${unchanged ? ', directory_dirty = 0' : ''} WHERE id = 1`,
  ).run(at);
  return unchanged;
}

export function recordDirectoryPingFailure(sqlite: Database.Database, error: DirectoryPingError): void {
  sqlite.prepare('UPDATE instance_settings SET directory_last_error = ? WHERE id = 1').run(JSON.stringify(error));
}

/** The hub answered 410: nothing is owed any more, whatever changed. */
export function clearDirectoryDirty(sqlite: Database.Database): void {
  sqlite.prepare('UPDATE instance_settings SET directory_dirty = 0 WHERE id = 1').run();
}

export function _resetDirectoryStateForTests(): void {
  documentVersion = 0;
  listeners.clear();
}
