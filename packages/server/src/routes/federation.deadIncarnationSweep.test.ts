import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

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

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  _sf = 1;
});

function seedUser(row: Partial<typeof schema.users.$inferInsert> & { id: string; username: string }): void {
  testDb.insert(schema.users).values({
    passwordHash: '!federation-replicated', createdAt: 1, ...row,
  } as typeof schema.users.$inferInsert).run();
}

describe('sweepDeadIncarnationArtifacts', () => {
  beforeEach(() => {
    // Junk: self-homed stub (home.test == our domain) + channel with no native member.
    seedUser({ id: 'junk-stub', username: 'youruser@home.test@home.test', homeInstance: 'home.test', homeUserId: 'dead-1' });
    seedUser({ id: 'remote-stub', username: 'bob@orbit.test', homeInstance: 'orbit.test', homeUserId: 'bob-home' });
    testDb.insert(schema.dmChannels).values({ id: 'junk-ch', federatedId: 'fed-junk', createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'junk-ch', userId: 'junk-stub', closed: 0 },
      { dmChannelId: 'junk-ch', userId: 'remote-stub', closed: 0 },
    ]).run();
    testDb.insert(schema.dmMessages).values({
      id: 'junk-msg', dmChannelId: 'junk-ch', userId: 'junk-stub', content: 'jo', createdAt: 1,
    }).run();
    // Legit: native alice + remote bob channel.
    seedUser({ id: 'alice', username: 'alice', passwordHash: 'real-hash', homeInstance: null });
    testDb.insert(schema.dmChannels).values({ id: 'live-ch', federatedId: 'fed-live', createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'live-ch', userId: 'alice', closed: 0 },
      { dmChannelId: 'live-ch', userId: 'remote-stub', closed: 0 },
    ]).run();
    testDb.insert(schema.dmMessages).values({
      id: 'live-msg', dmChannelId: 'live-ch', userId: 'remote-stub', content: 'hey', createdAt: 1,
    }).run();
    // Junk friendship referencing the self-homed stub.
    testDb.insert(schema.friends).values({ userId: 'alice', friendId: 'junk-stub', createdAt: 1 }).run();
  });

  it('removes native-less channels (with contents) and self-homed stubs; keeps legit data', async () => {
    const { sweepDeadIncarnationArtifacts } = await import('./federation.js');
    sweepDeadIncarnationArtifacts();

    expect(testDb.select().from(schema.dmChannels).all().map(c => c.id)).toEqual(['live-ch']);
    expect(testDb.select().from(schema.dmMessages).all().map(m => m.id)).toEqual(['live-msg']);
    expect(testDb.select().from(schema.dmMembers).all().every(m => m.dmChannelId === 'live-ch')).toBe(true);
    const userIds = testDb.select().from(schema.users).all().map(u => u.id).sort();
    expect(userIds).toEqual(['alice', 'remote-stub']);
    expect(testDb.select().from(schema.friends).all()).toEqual([]);
  });

  it('is idempotent — second run is a no-op', async () => {
    const { sweepDeadIncarnationArtifacts } = await import('./federation.js');
    sweepDeadIncarnationArtifacts();
    const snapshotUsers = testDb.select().from(schema.users).all();
    sweepDeadIncarnationArtifacts();
    expect(testDb.select().from(schema.users).all()).toEqual(snapshotUsers);
  });

  it('skips (does not delete) a self-homed stub that still authors a SPACE message', async () => {
    testDb.insert(schema.spaces).values({ id: 's1', name: 'S', ownerId: 'alice', createdAt: 1 }).run();
    testDb.insert(schema.channels).values({ id: 'c1', spaceId: 's1', name: 'general', type: 'text', createdAt: 1 }).run();
    testDb.insert(schema.messages).values({ id: 'sm1', channelId: 'c1', userId: 'junk-stub', content: 'x', createdAt: 1 }).run();
    const { sweepDeadIncarnationArtifacts } = await import('./federation.js');
    sweepDeadIncarnationArtifacts();
    // Channel cleanup still ran, but the referenced stub survives (logged as skipped).
    expect(testDb.select().from(schema.users).all().some(u => u.id === 'junk-stub')).toBe(true);
  });

  it('never touches DETACHED accounts (homed at the peer, not us)', async () => {
    seedUser({ id: 'detached-1', username: 'dave@orbit.test', passwordHash: 'real-hash', homeInstance: 'orbit.test', homeUserId: 'dave-home', federationHomeOrphaned: 1 });
    const { sweepDeadIncarnationArtifacts } = await import('./federation.js');
    sweepDeadIncarnationArtifacts();
    expect(testDb.select().from(schema.users).all().some(u => u.id === 'detached-1')).toBe(true);
  });
});
