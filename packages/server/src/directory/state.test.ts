import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from '../db/migrate.js';
import {
  readDirectoryState, markDirectoryDirty, getDocumentVersion, onDirectoryDirty,
  recordDirectoryPingSuccess, recordDirectoryPingFailure, clearDirectoryDirty, _resetDirectoryStateForTests,
} from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); applyMigrations(db); ensureDefaults(db); _resetDirectoryStateForTests(); });

describe('directory state', () => {
  it('starts off, clean and unversioned', () => {
    expect(readDirectoryState(db)).toEqual({ enabled: false, dirty: false, lastPingAt: null, lastError: null });
    expect(getDocumentVersion()).toBe(0);
  });

  it('marking dirty sets the flag, bumps the version and notifies', () => {
    const seen: number[] = [];
    const off = onDirectoryDirty(() => seen.push(getDocumentVersion()));
    markDirectoryDirty(db);
    markDirectoryDirty(db);
    off();
    markDirectoryDirty(db);
    expect(readDirectoryState(db).dirty).toBe(true);
    expect(getDocumentVersion()).toBe(3);
    expect(seen).toEqual([1, 2]);
  });

  it('a success clears the flag only when nothing changed since the ping was sent', () => {
    markDirectoryDirty(db);
    const sent = getDocumentVersion();
    markDirectoryDirty(db);
    expect(recordDirectoryPingSuccess(db, sent, 1000)).toBe(false);
    expect(readDirectoryState(db)).toMatchObject({ dirty: true, lastPingAt: 1000, lastError: null });
    expect(recordDirectoryPingSuccess(db, getDocumentVersion(), 2000)).toBe(true);
    expect(readDirectoryState(db)).toMatchObject({ dirty: false, lastPingAt: 2000 });
  });

  it('a failure keeps the flag and records the error; the next success clears the error', () => {
    markDirectoryDirty(db);
    recordDirectoryPingFailure(db, { at: 5, status: 'fetch', reason: 'origin-mismatch' });
    expect(readDirectoryState(db)).toMatchObject({ dirty: true, lastError: { at: 5, status: 'fetch', reason: 'origin-mismatch' } });
    recordDirectoryPingSuccess(db, getDocumentVersion(), 6);
    expect(readDirectoryState(db).lastError).toBeNull();
  });

  it('a corrupt stored error reads as none', () => {
    db.prepare("UPDATE instance_settings SET directory_last_error = '{not json' WHERE id = 1").run();
    expect(readDirectoryState(db).lastError).toBeNull();
  });

  it('clearDirectoryDirty is unconditional', () => {
    markDirectoryDirty(db);
    clearDirectoryDirty(db);
    expect(readDirectoryState(db).dirty).toBe(false);
  });
});
