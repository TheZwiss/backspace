import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { computeFederatedId } from '../utils/federationOutbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

let _sf = 1;
vi.mock('../utils/snowflake.js', () => ({
  generateSnowflake: () => String(_sf++),
  setWorkerId: vi.fn(),
}));

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://home.test' };
});

// federation.ts also imports connectionManager/ws — stub minimal surface so
// the route module loads at test time. The function under test doesn't touch any of these.
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    evictFederatedCallsForHost: vi.fn(),
    federatedCalls: new Map(),
    isUserOnline: vi.fn(),
    lateBindFederatedCall: vi.fn(),
  },
}));

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
  testDb.insert(schema.users).values({
    id, username: `${id}@x`, passwordHash: 'h',
    homeUserId, homeInstance, createdAt: 1,
  }).run();
}
function seedChannel(id: string, fedId: string | null, members: string[]): void {
  testDb.insert(schema.dmChannels).values({ id, federatedId: fedId, createdAt: 1 }).run();
  for (const u of members) testDb.insert(schema.dmMembers).values({ dmChannelId: id, userId: u, closed: 0 }).run();
}
function seedMsg(id: string, chId: string, userId: string, ts: number): void {
  testDb.insert(schema.dmMessages).values({ id, dmChannelId: chId, userId, content: 'x', createdAt: ts }).run();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  _sf = 1;
});

describe('reconcileDmChannelFederatedId', () => {
  it('noop when the stored id already matches the members', async () => {
    seedUser('a', 'a', null); seedUser('b', 'b-home', 'orbit.test');
    const fed = computeFederatedId('a', 'b-home');
    seedChannel('ch1', fed, ['a', 'b']);
    const { reconcileDmChannelFederatedId } = await import('./federation.js');
    const r = reconcileDmChannelFederatedId(sqlite, 'ch1');
    expect(r.action).toBe('noop');
    expect(testDb.select().from(schema.dmChannels).get()!.federatedId).toBe(fed);
  });

  it('re-keys in place when a member home id changed and no target exists', async () => {
    // member b now has NEW home id 'b-new'; channel still carries the OLD-pair id.
    seedUser('a', 'a', null); seedUser('b', 'b-new', 'orbit.test');
    const oldFed = computeFederatedId('a', 'b-old');
    seedChannel('ch1', oldFed, ['a', 'b']);
    const { reconcileDmChannelFederatedId } = await import('./federation.js');
    const r = reconcileDmChannelFederatedId(sqlite, 'ch1');
    expect(r.action).toBe('rekeyed');
    expect(testDb.select().from(schema.dmChannels).get()!.federatedId).toBe(computeFederatedId('a', 'b-new'));
  });

  it('merges into the target when one already carries the new id', async () => {
    seedUser('a', 'a', null); seedUser('b', 'b-new', 'orbit.test');
    const oldFed = computeFederatedId('a', 'b-old');
    const newFed = computeFederatedId('a', 'b-new');
    seedChannel('chOld', oldFed, ['a', 'b']); seedMsg('m1', 'chOld', 'a', 100); seedMsg('m2', 'chOld', 'b', 110);
    seedChannel('chNew', newFed, ['a', 'b']); seedMsg('m3', 'chNew', 'a', 120);
    const { reconcileDmChannelFederatedId } = await import('./federation.js');
    const r = reconcileDmChannelFederatedId(sqlite, 'chOld');
    expect(r.action).toBe('merged');
    expect(r.targetChannelId).toBe('chNew');
    // old channel gone, all 3 messages now on chNew, ordered.
    expect(testDb.select().from(schema.dmChannels).all().map(c => c.id)).toEqual(['chNew']);
    const msgs = testDb.select().from(schema.dmMessages).all().filter(m => m.dmChannelId === 'chNew').sort((x, y) => x.createdAt - y.createdAt);
    expect(msgs.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
    // members deduped, read_states intact.
    expect(testDb.select().from(schema.dmMembers).all().filter(m => m.dmChannelId === 'chNew').map(m => m.userId).sort()).toEqual(['a', 'b']);
    expect(r.affectedUserIds.sort()).toEqual(['a', 'b']);
  });

  it('skips group DMs (UUID federatedId / >2 members)', async () => {
    seedUser('a', 'a', null); seedUser('b', 'b', null); seedUser('c', 'c', null);
    seedChannel('g1', 'c361f0db-d856-2b62-44f5-ed9eba92a67d', ['a', 'b', 'c']);
    const { reconcileDmChannelFederatedId } = await import('./federation.js');
    expect(reconcileDmChannelFederatedId(sqlite, 'g1').action).toBe('noop');
  });

  it('skips a channel with an unresolvable member set (not exactly 2)', async () => {
    seedUser('a', 'a', null);
    seedChannel('ch1', computeFederatedId('a', 'b'), ['a']);
    const { reconcileDmChannelFederatedId } = await import('./federation.js');
    expect(reconcileDmChannelFederatedId(sqlite, 'ch1').action).toBe('noop');
  });

  it('dedupes read_states on merge (composite PK user_id+channel_id)', async () => {
    seedUser('a', 'a', null); seedUser('b', 'b-new', 'orbit.test');
    const oldFed = computeFederatedId('a', 'b-old'); const newFed = computeFederatedId('a', 'b-new');
    seedChannel('chOld', oldFed, ['a', 'b']); seedMsg('m1', 'chOld', 'a', 100);
    seedChannel('chNew', newFed, ['a', 'b']); seedMsg('m2', 'chNew', 'a', 120);
    testDb.insert(schema.readStates).values([
      { userId: 'a', channelId: 'chOld', lastReadMessageId: 'm1', updatedAt: 1 },
      { userId: 'a', channelId: 'chNew', lastReadMessageId: 'm2', updatedAt: 2 },
    ]).run();
    const { reconcileDmChannelFederatedId } = await import('./federation.js');
    reconcileDmChannelFederatedId(sqlite, 'chOld');
    const rs = testDb.select().from(schema.readStates).all();
    expect(rs.filter(r => r.channelId === 'chOld')).toHaveLength(0);
    expect(rs.filter(r => r.channelId === 'chNew' && r.userId === 'a')).toHaveLength(1);
  });
});
