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
vi.mock('./snowflake.js', () => ({
  generateSnowflake: () => String(_sf++),
  setWorkerId: vi.fn(),
}));

vi.mock('./federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('./federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://home.test' };
});

// federationOutbox.ts imports extractDomain from routes/federation.js, which in
// turn imports connectionManager/ws — stub the minimal surface so the module
// graph loads at test time. getDmParticipants doesn't touch any of these.
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

describe('getDmParticipants — deleted members', () => {
  it('ships deleted:true and NO username for tombstoned members', async () => {
    testDb.insert(schema.users).values([
      { id: 'alice', username: 'alice', passwordHash: 'h', homeInstance: null, createdAt: 1 },
      { id: 'ghost', username: '!deleted:ghost', passwordHash: 'h', homeInstance: null, isDeleted: 1, createdAt: 1 },
    ]).run();
    testDb.insert(schema.dmChannels).values({ id: 'ch1', federatedId: 'fed-ch1', createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'ch1', userId: 'alice', closed: 0 },
      { dmChannelId: 'ch1', userId: 'ghost', closed: 0 },
    ]).run();

    const { getDmParticipants } = await import('./federationOutbox.js');
    const participants = getDmParticipants('ch1');
    const ghost = participants.find(p => p.homeUserId === 'ghost')!;
    expect(ghost.profile?.deleted).toBe(true);
    expect(ghost.profile?.username ?? null).toBeNull();
    expect(ghost.profile?.displayName ?? null).toBeNull();
    const alice = participants.find(p => p.homeUserId === 'alice')!;
    expect(alice.profile?.deleted ?? undefined).toBeUndefined();
    expect(alice.profile?.username).toBe('alice');
  });
});
