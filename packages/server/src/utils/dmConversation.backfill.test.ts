import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillOneOnOneKeys, oneOnOneKey } from './dmConversation.js';

/**
 * The startup sweep `initDatabase` runs (ADR 0002, "Backfill"): every 1-on-1
 * row ends up holding the key of its two members, whatever path created it and
 * whether or not relay was on at the time.
 */

/** The 1-on-1 key of two home identities. */
const pairKey = (a: string, b: string): string => oneOnOneKey({ id: a, homeUserId: null }, { id: b, homeUserId: null });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sqlite: Database.Database;

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(id: string, homeUserId: string | null, homeInstance: string | null): void {
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, home_user_id, home_instance, created_at) VALUES (?, ?, 'h', ?, ?, 1)`)
    .run(id, `${id}@x`, homeUserId, homeInstance);
}
function seedChannel(
  id: string,
  fedId: string | null,
  members: string[],
  opts: { ownerId?: string; deletedAt?: number; closed?: Record<string, number>; createdAt?: number } = {},
): void {
  sqlite.prepare(`INSERT INTO dm_channels (id, owner_id, federated_id, deleted_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, opts.ownerId ?? null, fedId, opts.deletedAt ?? null, opts.createdAt ?? 1);
  for (const u of members) {
    sqlite.prepare(`INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES (?, ?, ?)`).run(id, u, opts.closed?.[u] ?? 0);
  }
}
function seedMsg(id: string, chId: string, userId: string, ts: number): void {
  sqlite.prepare(`INSERT INTO dm_messages (id, dm_channel_id, user_id, content, created_at) VALUES (?, ?, ?, 'x', ?)`).run(id, chId, userId, ts);
}
function keyOf(id: string): string | null | undefined {
  return (sqlite.prepare('SELECT federated_id AS fid FROM dm_channels WHERE id = ?').get(id) as { fid: string | null } | undefined)?.fid;
}
function channelIds(): string[] {
  return (sqlite.prepare('SELECT id FROM dm_channels ORDER BY id').all() as { id: string }[]).map(r => r.id);
}
function membersOf(id: string): Array<{ userId: string; closed: number }> {
  return sqlite.prepare('SELECT user_id AS userId, closed FROM dm_members WHERE dm_channel_id = ? ORDER BY user_id').all(id) as Array<{ userId: string; closed: number }>;
}
function messagesOf(id: string): string[] {
  return (sqlite.prepare('SELECT id FROM dm_messages WHERE dm_channel_id = ? ORDER BY created_at').all(id) as { id: string }[]).map(r => r.id);
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  applyMigrations(sqlite);
});

describe('backfillOneOnOneKeys', () => {
  it('keys a 1-on-1 made while relay was off, between a native and a user homed elsewhere', () => {
    seedUser('a', null, null); seedUser('b', 'b-home', 'orbit.test');
    seedChannel('ch1', null, ['a', 'b']);
    backfillOneOnOneKeys(sqlite);
    expect(keyOf('ch1')).toBe(pairKey('a', 'b-home'));
  });

  it('keys a 1-on-1 between two users of this instance', () => {
    seedUser('a', null, null); seedUser('c', null, null);
    seedChannel('ch1', null, ['a', 'c']);
    backfillOneOnOneKeys(sqlite);
    expect(keyOf('ch1')).toBe(pairKey('a', 'c'));
  });

  it('merges an unkeyed 1-on-1 into the relay-created row that holds its key', () => {
    seedUser('a', null, null); seedUser('b', 'b-home', 'orbit.test');
    seedChannel('chLegacy', null, ['a', 'b'], { createdAt: 1 }); seedMsg('m1', 'chLegacy', 'a', 100);
    seedChannel('chRelay', pairKey('a', 'b-home'), ['a', 'b'], { createdAt: 2 }); seedMsg('m2', 'chRelay', 'b', 200);
    backfillOneOnOneKeys(sqlite);
    expect(channelIds()).toEqual(['chRelay']);
    expect(messagesOf('chRelay')).toEqual(['m1', 'm2']);
    expect(membersOf('chRelay').map(m => m.userId)).toEqual(['a', 'b']);
  });

  it('never leaves a merged 1-on-1 with a third member when the two rows hold the same person under different local ids', () => {
    // An older stub and the current row for b's identity: the two rows hash to
    // the same key, so they are one conversation of two people.
    seedUser('a', null, null); seedUser('b-old', 'b-home', 'orbit.test'); seedUser('b', 'b-home', 'orbit.test');
    seedChannel('chLegacy', null, ['a', 'b-old']); seedMsg('m1', 'chLegacy', 'b-old', 100);
    seedChannel('chRelay', pairKey('a', 'b-home'), ['a', 'b']);
    backfillOneOnOneKeys(sqlite);
    expect(channelIds()).toEqual(['chRelay']);
    expect(membersOf('chRelay').map(m => m.userId)).toEqual(['a', 'b']);
    expect(messagesOf('chRelay')).toEqual(['m1']);
  });

  it('keeps a merged conversation open for a member who had the merged-away row open', () => {
    seedUser('a', null, null); seedUser('b', 'b-home', 'orbit.test');
    seedChannel('chLegacy', null, ['a', 'b'], { closed: { a: 0, b: 1 } }); seedMsg('m1', 'chLegacy', 'a', 100);
    seedChannel('chRelay', pairKey('a', 'b-home'), ['a', 'b'], { closed: { a: 1, b: 1 } });
    backfillOneOnOneKeys(sqlite);
    expect(membersOf('chRelay')).toEqual([{ userId: 'a', closed: 0 }, { userId: 'b', closed: 1 }]);
  });

  it('heals a drifted key and leaves a correct one untouched', () => {
    seedUser('a', null, null); seedUser('b', 'b-new', 'orbit.test'); seedUser('c', null, null);
    seedChannel('chOld', pairKey('a', 'b-old'), ['a', 'b']); seedMsg('m1', 'chOld', 'a', 100);
    seedChannel('chNew', pairKey('a', 'b-new'), ['a', 'b']); seedMsg('m2', 'chNew', 'a', 200);
    seedChannel('chOk', pairKey('a', 'c'), ['a', 'c']);
    backfillOneOnOneKeys(sqlite);
    expect(channelIds()).toEqual(['chNew', 'chOk']);
    expect(messagesOf('chNew')).toEqual(['m1', 'm2']);
    expect(keyOf('chOk')).toBe(pairKey('a', 'c'));
  });

  it('leaves groups, soft-deleted rows and rows without exactly two members alone', () => {
    seedUser('a', null, null); seedUser('b', 'b-home', 'orbit.test'); seedUser('c', null, null);
    // An unshared group keeps NULL (ADR 0002: groups are not backfilled).
    seedChannel('gUnshared', null, ['a', 'b'], { ownerId: 'a' });
    seedChannel('gShared', 'c361f0db-d856-4b62-84f5-ed9eba92a67d', ['a', 'b', 'c'], { ownerId: 'a' });
    seedChannel('chDeleted', null, ['a', 'c'], { deletedAt: 5 });
    seedChannel('chLonely', null, ['a']);
    backfillOneOnOneKeys(sqlite);
    expect(keyOf('gUnshared')).toBeNull();
    expect(keyOf('gShared')).toBe('c361f0db-d856-4b62-84f5-ed9eba92a67d');
    expect(keyOf('chDeleted')).toBeNull();
    expect(keyOf('chLonely')).toBeNull();
  });

  it('never takes an ownerless group copy (a group key) for a 1-on-1, with or without a 1-on-1 of the same pair', () => {
    // Up to 1.6.0 the member_add bootstrap could create a group copy without an
    // owner (owner unnamed or tombstoned). Its key is a UUID; with two local
    // members it has the shape of a 1-on-1 in every other respect.
    const groupKey = '00000000-0000-4000-8000-000000000001';
    seedUser('x', null, null); seedUser('y', 'y-home', 'orbit.test');
    seedChannel('grp', groupKey, ['x', 'y']); seedMsg('mg', 'grp', 'x', 100);
    backfillOneOnOneKeys(sqlite);
    expect(keyOf('grp')).toBe(groupKey);
    expect(messagesOf('grp')).toEqual(['mg']);

    seedChannel('one', null, ['x', 'y']); seedMsg('m1', 'one', 'y', 200);
    backfillOneOnOneKeys(sqlite);
    expect(channelIds()).toEqual(['grp', 'one']);
    expect(keyOf('grp')).toBe(groupKey);
    expect(keyOf('one')).toBe(pairKey('x', 'y-home'));
    expect(messagesOf('grp')).toEqual(['mg']);
    expect(messagesOf('one')).toEqual(['m1']);
  });

  it('calls beforeChanges once before it re-keys or merges anything, and not at all when there is nothing to do', () => {
    seedUser('a', null, null); seedUser('b', 'b-home', 'orbit.test'); seedUser('c', null, null);
    seedChannel('ok', pairKey('a', 'c'), ['a', 'c']);
    const calls: Array<string | null | undefined> = [];
    backfillOneOnOneKeys(sqlite, { beforeChanges: () => { calls.push(keyOf('ch1')); } });
    expect(calls).toEqual([]);

    seedChannel('ch1', null, ['a', 'b']);
    backfillOneOnOneKeys(sqlite, { beforeChanges: () => { calls.push(keyOf('ch1')); } });
    // Called once, while the row still had no key.
    expect(calls).toEqual([null]);
    expect(keyOf('ch1')).toBe(pairKey('a', 'b-home'));
  });

  it('is idempotent: a second run changes nothing', () => {
    seedUser('a', null, null); seedUser('b', 'b-home', 'orbit.test'); seedUser('c', null, null);
    seedChannel('ch1', null, ['a', 'b']);
    seedChannel('ch2', pairKey('a', 'c'), ['a', 'c']);
    backfillOneOnOneKeys(sqlite);
    const before = sqlite.prepare('SELECT * FROM dm_channels ORDER BY id').all();
    backfillOneOnOneKeys(sqlite);
    expect(sqlite.prepare('SELECT * FROM dm_channels ORDER BY id').all()).toEqual(before);
  });
});
