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

const STATUSES = new Set(['network', 'timeout', 'origin', 'fetch']);
const REASONS = new Set(['unreachable', 'status', 'invalid', 'origin-mismatch']);

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
    if (typeof reason === 'string' && REASONS.has(reason)) out.reason = reason as DirectoryPingError['reason'];
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
