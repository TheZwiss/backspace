import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillOneOnOneDmMembership } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let db: Database.Database;

function applyMigrations(d: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort())
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const c = stmt.trim(); if (c) d.exec(c);
    }
}
const now = Date.now();
const insUser = (id: string, isDeleted = 0) => db.prepare('INSERT INTO users (id, username, password_hash, created_at, is_deleted) VALUES (?,?,?,?,?)').run(id, id, 'x', now, isDeleted);
const insDm = (id: string) => db.prepare('INSERT INTO dm_channels (id, owner_id, created_at) VALUES (?,NULL,?)').run(id, now);
const insMember = (dm: string, u: string) => db.prepare('INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES (?,?,0)').run(dm, u);
const insMsg = (id: string, dm: string, u: string) => db.prepare('INSERT INTO dm_messages (id, dm_channel_id, user_id, content, created_at) VALUES (?,?,?,?,?)').run(id, dm, u, 'hi', now);
const memberCount = (dm: string) => (db.prepare('SELECT COUNT(*) AS c FROM dm_members WHERE dm_channel_id = ?').get(dm) as { c: number }).c;

describe('backfillOneOnOneDmMembership', () => {
  beforeEach(() => { db = new Database(':memory:'); applyMigrations(db); });
  afterEach(() => db.close());

  it('re-inserts the missing (deleted) partner membership from message authorship', () => {
    insUser('dead', 1); insUser('survivor');
    insDm('dm1'); insMember('dm1', 'survivor');       // partner membership missing (old bug)
    insMsg('m1', 'dm1', 'dead'); insMsg('m2', 'dm1', 'survivor');
    backfillOneOnOneDmMembership(db);
    expect(memberCount('dm1')).toBe(2);
    expect(db.prepare('SELECT 1 FROM dm_members WHERE dm_channel_id=? AND user_id=?').get('dm1', 'dead')).toBeTruthy();
  });

  it('is idempotent and leaves healthy / unrecoverable channels untouched', () => {
    insUser('a'); insUser('b');
    insDm('healthy'); insMember('healthy', 'a'); insMember('healthy', 'b'); // 2 members → skip
    insDm('unrecoverable'); insMember('unrecoverable', 'a'); // partner never messaged / gone
    backfillOneOnOneDmMembership(db);
    backfillOneOnOneDmMembership(db); // second run must be a no-op
    expect(memberCount('healthy')).toBe(2);
    expect(memberCount('unrecoverable')).toBe(1);
  });
});
