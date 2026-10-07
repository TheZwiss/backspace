import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Migration 0022 (#255): the pull-sync tables, `dm_members.closed_changed_at`,
 * `instance_settings.ledger_started_at`, and its hand-written data statements:
 * - every existing member row takes the migration time as the moment its
 *   `closed` state was set, so no close or reopen from before the upgrade
 *   that a pull replays applies;
 * - the ledger start is the migration time on an existing instance;
 * - every peer that has synced before gets a cursor per context at its
 *   `last_synced_at`, where the pull this release replaces would have
 *   continued, so the first pull does not replay the peer's whole log. A
 *   peer that never synced gets none (its cursors start at 0 when created).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');
const TAG = '0022_peer_resync';

function statementsOf(file: string): string[] {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    .split(/-->\s*statement-breakpoint/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function applyUpTo(db: Database.Database, tag: string): void {
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    if (file.startsWith(tag)) return;
    for (const stmt of statementsOf(file)) db.exec(stmt);
  }
  throw new Error(`migration ${tag} not found`);
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyUpTo(db, TAG);
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'u1', 'x', 1);
  db.prepare('INSERT INTO dm_channels (id, created_at) VALUES (?, ?)').run('ch', 1);
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES (?, ?, 1)').run('ch', 'u1');
  const peer = db.prepare(`
    INSERT INTO federation_peers (id, origin, hmac_secret, status, last_synced_at, created_at, peer_instance_id)
    VALUES (?, ?, 'secret', 'active', ?, 1, ?)
  `);
  peer.run('synced', 'https://synced.example', 5_000, 'epoch-1');
  peer.run('never', 'https://never.example', 0, null);
});

describe('migration 0022_peer_resync', () => {
  it('stamps existing member rows with the migration time', () => {
    const before = Date.now() - 1_000;
    for (const stmt of statementsOf(`${TAG}.sql`)) db.exec(stmt);
    const row = db.prepare('SELECT closed, closed_changed_at FROM dm_members').get() as { closed: number; closed_changed_at: number };
    expect(row.closed).toBe(1);
    expect(row.closed_changed_at).toBeGreaterThanOrEqual(before);
    expect(row.closed_changed_at).toBeLessThanOrEqual(Date.now());
  });

  it('starts every cursor of a peer that synced before at its last sync, and of no other', () => {
    for (const stmt of statementsOf(`${TAG}.sql`)) db.exec(stmt);
    const cursors = db.prepare('SELECT peer_id, context_type, cursor_ts, cursor_id, peer_epoch FROM federation_sync_cursors ORDER BY context_type').all();
    expect(cursors).toEqual(['dm', 'friend', 'profile'].map(context_type => ({
      peer_id: 'synced', context_type, cursor_ts: 5_000, cursor_id: null, peer_epoch: 'epoch-1',
    })));
  });

  it('stamps the ledger start with the migration time on an existing instance', () => {
    db.prepare('INSERT INTO instance_settings (id, updated_at) VALUES (1, 1)').run();
    const before = Date.now() - 1_000;
    for (const stmt of statementsOf(`${TAG}.sql`)) db.exec(stmt);
    const row = db.prepare('SELECT ledger_started_at FROM instance_settings').get() as { ledger_started_at: number };
    expect(row.ledger_started_at).toBeGreaterThanOrEqual(before);
    expect(row.ledger_started_at).toBeLessThanOrEqual(Date.now());
  });
});
