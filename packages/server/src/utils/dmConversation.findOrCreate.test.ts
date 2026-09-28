import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';
import { findOrCreateOneOnOne, oneOnOneKey, type HomeIdentified } from './dmConversation.js';

setWorkerId(3);

/**
 * `findOrCreateOneOnOne` (ADR 0002, "Server find-or-create for 1-on-1s"): the
 * row holding the pair's key is the conversation; else a row whose members are
 * exactly the pair, keyed on the way out; else a new keyed row.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function applyMigrations(target: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) target.exec(clean);
    }
  }
}

function seedUser(id: string, homeUserId: string | null = null, homeInstance: string | null = null): HomeIdentified {
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, home_user_id, home_instance, created_at) VALUES (?, ?, 'h', ?, ?, 1)`)
    .run(id, `${id}@x`, homeUserId, homeInstance);
  return { id, homeUserId };
}
function seedChannel(id: string, fedId: string | null, members: string[], ownerId: string | null = null): void {
  sqlite.prepare(`INSERT INTO dm_channels (id, owner_id, federated_id, created_at) VALUES (?, ?, ?, 1)`).run(id, ownerId, fedId);
  for (const u of members) sqlite.prepare(`INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES (?, ?, 0)`).run(id, u);
}
function membersOf(id: string): Array<{ userId: string; closed: number }> {
  return sqlite.prepare('SELECT user_id AS userId, closed FROM dm_members WHERE dm_channel_id = ? ORDER BY user_id').all(id) as Array<{ userId: string; closed: number }>;
}
function keyOf(id: string): string | null {
  return (sqlite.prepare('SELECT federated_id AS fid FROM dm_channels WHERE id = ?').get(id) as { fid: string | null }).fid;
}
function channelCount(): number {
  return (sqlite.prepare('SELECT count(*) AS n FROM dm_channels').get() as { n: number }).n;
}

let alice: HomeIdentified;
let bob: HomeIdentified;

beforeEach(() => {
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  alice = seedUser('alice');
  bob = seedUser('bob-stub', 'bob-home', 'orbit.test');
});

describe('findOrCreateOneOnOne', () => {
  it('inserts a keyed row with both members open when the pair has none', () => {
    const r = findOrCreateOneOnOne(db, alice, bob, { open: 'both' });
    expect(r.created).toBe(true);
    expect(keyOf(r.channelId)).toBe(oneOnOneKey(alice, bob));
    expect(membersOf(r.channelId)).toEqual([{ userId: 'alice', closed: 0 }, { userId: 'bob-stub', closed: 0 }]);
  });

  it('opened by the first party, inserts the other party\'s membership closed', () => {
    const r = findOrCreateOneOnOne(db, alice, bob, { open: 'first' });
    expect(r.created).toBe(true);
    expect(membersOf(r.channelId)).toEqual([{ userId: 'alice', closed: 0 }, { userId: 'bob-stub', closed: 1 }]);
  });

  it('returns the row holding the key and adds the pair member it lacks', () => {
    seedChannel('relayed', oneOnOneKey(alice, bob), ['bob-stub']);
    const r = findOrCreateOneOnOne(db, alice, bob, { open: 'both' });
    expect(r).toEqual({ channelId: 'relayed', created: false });
    expect(membersOf('relayed')).toEqual([{ userId: 'alice', closed: 0 }, { userId: 'bob-stub', closed: 0 }]);
  });

  it('adds a lacking other party closed when the first party opens it', () => {
    seedChannel('relayed', oneOnOneKey(alice, bob), ['alice']);
    findOrCreateOneOnOne(db, alice, bob, { open: 'first' });
    expect(membersOf('relayed')).toEqual([{ userId: 'alice', closed: 0 }, { userId: 'bob-stub', closed: 1 }]);
  });

  it('re-points a member row that holds the same person under another local id, never adding a third', () => {
    seedUser('bob-old', 'bob-home', 'orbit.test');
    seedChannel('relayed', oneOnOneKey(alice, bob), ['alice', 'bob-old']);
    sqlite.prepare(`UPDATE dm_members SET closed = 1 WHERE dm_channel_id = 'relayed' AND user_id = 'bob-old'`).run();
    const r = findOrCreateOneOnOne(db, alice, bob, { open: 'both' });
    expect(r).toEqual({ channelId: 'relayed', created: false });
    expect(membersOf('relayed')).toEqual([{ userId: 'alice', closed: 0 }, { userId: 'bob-stub', closed: 1 }]);
    expect(channelCount()).toBe(1);
  });

  it('collapses a key row that holds one person under two local ids to one row, keeping it open if either was', () => {
    // Left by the relay's old find-or-create, which added a pair member under a
    // new local id to a row that already held the person under an old one.
    seedUser('bob-old', 'bob-home', 'orbit.test');
    seedChannel('relayed', oneOnOneKey(alice, bob), ['alice', 'bob-stub', 'bob-old']);
    sqlite.prepare(`UPDATE dm_members SET closed = 1 WHERE dm_channel_id = 'relayed' AND user_id = 'bob-stub'`).run();
    const r = findOrCreateOneOnOne(db, alice, bob, { open: 'both' });
    expect(r).toEqual({ channelId: 'relayed', created: false });
    expect(membersOf('relayed')).toEqual([{ userId: 'alice', closed: 0 }, { userId: 'bob-stub', closed: 0 }]);
    expect(channelCount()).toBe(1);
  });

  it('keys and returns an unkeyed row whose members are exactly the pair', () => {
    seedChannel('legacy', null, ['alice', 'bob-stub']);
    const r = findOrCreateOneOnOne(db, alice, bob, { open: 'first' });
    expect(r).toEqual({ channelId: 'legacy', created: false });
    expect(keyOf('legacy')).toBe(oneOnOneKey(alice, bob));
    expect(channelCount()).toBe(1);
  });

  it('never takes a group with the same two members for the 1-on-1', () => {
    seedChannel('group', null, ['alice', 'bob-stub'], 'alice');
    const r = findOrCreateOneOnOne(db, alice, bob, { open: 'both' });
    expect(r.created).toBe(true);
    expect(r.channelId).not.toBe('group');
    expect(keyOf('group')).toBeNull();
  });

  it('never takes an ownerless group copy with the pair\'s two members for the 1-on-1', () => {
    const groupKey = '00000000-0000-4000-8000-000000000001';
    seedChannel('groupCopy', groupKey, ['alice', 'bob-stub']);
    const r = findOrCreateOneOnOne(db, alice, bob, { open: 'both' });
    expect(r.created).toBe(true);
    expect(r.channelId).not.toBe('groupCopy');
    expect(keyOf('groupCopy')).toBe(groupKey);
  });

  it('moves a row that holds the key under other members to its own key, then creates the pair\'s row', () => {
    // Drift: the row carries the alice-bob key but its members are alice and carol.
    const carol = seedUser('carol');
    seedChannel('drifted', oneOnOneKey(alice, bob), ['alice', 'carol']);
    const r = findOrCreateOneOnOne(db, alice, bob, { open: 'both' });
    expect(r.created).toBe(true);
    expect(keyOf(r.channelId)).toBe(oneOnOneKey(alice, bob));
    expect(keyOf('drifted')).toBe(oneOnOneKey(alice, carol));
    expect(membersOf('drifted').map(m => m.userId)).toEqual(['alice', 'carol']);
  });
});
