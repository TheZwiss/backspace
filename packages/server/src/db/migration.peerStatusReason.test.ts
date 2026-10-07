import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Migration 0023: `needs_attention_reason` becomes `status_reason`, and its
 * hand-written data statements:
 * - a reason is kept only on a needs_attention row. Before the upgrade a row
 *   leaving needs_attention (our admin denying it, a revoke) could keep its
 *   old value, and on a rejected row a reason now says which side refused;
 * - a needs_attention row without a reason came from the auth-failure
 *   threshold, the one path that wrote none, and gets `auth_failures`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');
const TAG = '0023_peer_status_reason';

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

function seedPeer(db: Database.Database, id: string, status: string, reason: string | null): void {
  db.prepare(`
    INSERT INTO federation_peers (id, origin, hmac_secret, status, needs_attention_reason, created_at)
    VALUES (?, ?, 'secret', ?, ?, 1)
  `).run(id, `https://${id}.example`, status, reason);
}

function reasonOf(db: Database.Database, id: string): { status: string; status_reason: string | null } {
  return db.prepare('SELECT status, status_reason FROM federation_peers WHERE id = ?').get(id) as {
    status: string;
    status_reason: string | null;
  };
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyUpTo(db, TAG);
});

describe('migration 0023_peer_status_reason', () => {
  it('clears the old reason of a needs_attention row our admin later denied, so it stays denied', () => {
    seedPeer(db, 'denied-reset', 'rejected', 'peer_reset_detected');
    seedPeer(db, 'denied-repeer', 'rejected', 'repeer_incomplete');
    for (const stmt of statementsOf(`${TAG}.sql`)) db.exec(stmt);
    expect(reasonOf(db, 'denied-reset')).toEqual({ status: 'rejected', status_reason: null });
    expect(reasonOf(db, 'denied-repeer')).toEqual({ status: 'rejected', status_reason: null });
  });

  it('clears an old reason on a revoked or active row', () => {
    seedPeer(db, 'revoked', 'revoked', 'auth_failures');
    seedPeer(db, 'active', 'active', 'peer_reset_detected');
    for (const stmt of statementsOf(`${TAG}.sql`)) db.exec(stmt);
    expect(reasonOf(db, 'revoked')).toEqual({ status: 'revoked', status_reason: null });
    expect(reasonOf(db, 'active')).toEqual({ status: 'active', status_reason: null });
  });

  it('keeps the reason of a needs_attention row', () => {
    seedPeer(db, 'reset', 'needs_attention', 'peer_reset_detected');
    seedPeer(db, 'repeer', 'needs_attention', 'repeer_incomplete');
    for (const stmt of statementsOf(`${TAG}.sql`)) db.exec(stmt);
    expect(reasonOf(db, 'reset')).toEqual({ status: 'needs_attention', status_reason: 'peer_reset_detected' });
    expect(reasonOf(db, 'repeer')).toEqual({ status: 'needs_attention', status_reason: 'repeer_incomplete' });
  });

  it('gives a needs_attention row without a reason auth_failures, and no other row', () => {
    seedPeer(db, 'threshold', 'needs_attention', null);
    seedPeer(db, 'old-rejected', 'rejected', null);
    for (const stmt of statementsOf(`${TAG}.sql`)) db.exec(stmt);
    expect(reasonOf(db, 'threshold')).toEqual({ status: 'needs_attention', status_reason: 'auth_failures' });
    expect(reasonOf(db, 'old-rejected')).toEqual({ status: 'rejected', status_reason: null });
  });
});
