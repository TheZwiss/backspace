import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

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

describe('resolveOrCreateReplicatedUser — stub username', () => {
  it('creates stub with realname@domain when hint provides username', async () => {
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const created = resolveOrCreateReplicatedUser(
      '310002371434024960',
      'orbit.ddns.net',
      testDb,
      { username: 'pbtest3' },
    );
    expect(created).not.toBeNull();
    expect(created!.username).toBe('pbtest3@orbit.ddns.net');
    expect(created!.homeUserId).toBe('310002371434024960');
    expect(created!.homeInstance).toBe('orbit.ddns.net');
  });

  it('falls back to homeUserId@domain when no hint provided', async () => {
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const created = resolveOrCreateReplicatedUser(
      '310002371434024960',
      'orbit.ddns.net',
      testDb,
    );
    expect(created!.username).toBe('310002371434024960@orbit.ddns.net');
  });
});

describe('resolveOrCreateReplicatedUser — self-homed identity guard', () => {
  it('refuses to create a stub homed at our own domain (dead incarnation)', async () => {
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const result = resolveOrCreateReplicatedUser(
      'dead-incarnation-id',
      'home.test',
      testDb,
      { username: 'youruser' },
    );
    expect(result).toBeNull();
    const rows = testDb.select().from(schema.users).all();
    expect(rows).toHaveLength(0);
  });

  it('refuses self-homed creation regardless of homeInstance URL shape', async () => {
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    expect(resolveOrCreateReplicatedUser('dead-1', 'https://home.test', testDb, { username: 'x' })).toBeNull();
    expect(resolveOrCreateReplicatedUser('dead-2', 'HOME.TEST', testDb, { username: 'x' })).toBeNull();
    expect(testDb.select().from(schema.users).all()).toHaveLength(0);
  });

  it('still resolves a LIVE native user referenced by self-domain identity (tier 1)', async () => {
    testDb.insert(schema.users).values({
      id: 'native-1',
      username: 'alice',
      passwordHash: 'real-hash',
      homeInstance: null,
      createdAt: 1,
    }).run();
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const result = resolveOrCreateReplicatedUser('native-1', 'https://home.test', testDb, { username: 'alice' });
    expect(result).not.toBeNull();
    expect(result!.id).toBe('native-1');
  });

  it('still creates stubs for remote-domain identities (unchanged behavior)', async () => {
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const result = resolveOrCreateReplicatedUser('remote-1', 'orbit.ddns.net', testDb, { username: 'bob' });
    expect(result).not.toBeNull();
    expect(result!.username).toBe('bob@orbit.ddns.net');
  });
});
