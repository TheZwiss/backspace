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

describe('reconcileDriftedDmFederatedIds', () => {
  it('heals a drifted 1-on-1 channel and leaves correct ones untouched', async () => {
    seedUser('a', 'a', null); seedUser('b', 'b-new', 'orbit.test'); seedUser('c', 'c', null);
    // drifted: stored under old pairing, member b now has b-new; target under new pairing exists.
    const oldFed = computeFederatedId('a', 'b-old'); const newFed = computeFederatedId('a', 'b-new');
    seedChannel('chOld', oldFed, ['a', 'b']); seedMsg('m1', 'chOld', 'a', 100);
    seedChannel('chNew', newFed, ['a', 'b']); seedMsg('m2', 'chNew', 'a', 200);
    // correct channel untouched
    const okFed = computeFederatedId('a', 'c'); seedChannel('chOk', okFed, ['a', 'c']);

    const { reconcileDriftedDmFederatedIds } = await import('./federation.js');
    reconcileDriftedDmFederatedIds();

    expect(testDb.select().from(schema.dmChannels).all().map(c => c.id).sort()).toEqual(['chNew', 'chOk']);
    expect(testDb.select().from(schema.dmMessages).all().filter(m => m.dmChannelId === 'chNew').map(m => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('is idempotent — second run is a noop', async () => {
    seedUser('a', 'a', null); seedUser('b', 'b', null);
    seedChannel('ch1', computeFederatedId('a', 'b'), ['a', 'b']);
    const { reconcileDriftedDmFederatedIds } = await import('./federation.js');
    reconcileDriftedDmFederatedIds();
    const before = testDb.select().from(schema.dmChannels).all();
    reconcileDriftedDmFederatedIds();
    expect(testDb.select().from(schema.dmChannels).all()).toEqual(before);
  });

  it('does not touch group DMs', async () => {
    seedUser('a', 'a', null); seedUser('b', 'b', null); seedUser('c', 'c', null);
    seedChannel('g1', 'c361f0db-d856-2b62-44f5-ed9eba92a67d', ['a', 'b', 'c']);
    const { reconcileDriftedDmFederatedIds } = await import('./federation.js');
    reconcileDriftedDmFederatedIds();
    expect(testDb.select().from(schema.dmChannels).all().some(c => c.id === 'g1')).toBe(true);
  });
});
