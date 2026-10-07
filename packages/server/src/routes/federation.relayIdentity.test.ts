import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Identity lookups by `homeUserId` + `homeInstance`.
 *
 * This instance's transport origin (`getOurOrigin`) and its identity domain
 * (`DOMAIN`) are deliberately different here, so the suite shows that a native
 * user is reached under either of this instance's own names and under no other.
 */

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
  generateSnowflake: () => `sf-${_sf++}`,
  setWorkerId: vi.fn(),
}));

vi.mock('../config.js', async (importActual) => {
  const actual = await importActual<typeof import('../config.js')>();
  return { config: { ...actual.config, domain: 'home.test' } };
});

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://public.test' };
});

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    evictFederatedCallsForHost: vi.fn(),
    dropRemoteCallParticipants: vi.fn().mockReturnValue(0),
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

function insertNative(id: string, username: string): void {
  testDb.insert(schema.users).values({
    id, username, passwordHash: 'real-hash', homeInstance: null, createdAt: 1,
  }).run();
}

function insertStub(id: string, username: string, homeInstance: string, homeUserId: string | null): void {
  testDb.insert(schema.users).values({
    id, username, passwordHash: '!federation-replicated', homeInstance, homeUserId, createdAt: 1,
  }).run();
}

const userCount = (): number => testDb.select().from(schema.users).all().length;

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  _sf = 1;
});

describe('resolveOrCreateReplicatedUser: identity is homeUserId + homeInstance', () => {
  it('reaches a native user named with this instance\'s transport domain', async () => {
    insertNative('n1', 'bob');
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    expect(resolveOrCreateReplicatedUser('n1', 'public.test', testDb)?.id).toBe('n1');
    expect(resolveOrCreateReplicatedUser('n1', 'https://public.test', testDb)?.id).toBe('n1');
  });

  it('reaches a native user named with this instance\'s identity domain', async () => {
    insertNative('n1', 'bob');
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    expect(resolveOrCreateReplicatedUser('n1', 'home.test', testDb)?.id).toBe('n1');
    expect(resolveOrCreateReplicatedUser('n1', 'HTTPS://HOME.TEST', testDb)?.id).toBe('n1');
  });

  it('does not reach a native user when the id is named as homed on another instance, and creates nothing', async () => {
    insertNative('n1', 'bob');
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    expect(resolveOrCreateReplicatedUser('n1', 'orbit.test', testDb, { username: 'bob' })).toBeNull();
    expect(userCount()).toBe(1);
  });

  it('does not fall through to the username hint when the id belongs to another identity', async () => {
    insertNative('n1', 'bob');
    insertStub('s1', 'bob@orbit.test', 'orbit.test', null);
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    expect(resolveOrCreateReplicatedUser('n1', 'orbit.test', testDb, { username: 'bob' })).toBeNull();
    const stub = testDb.select().from(schema.users).where(eq(schema.users.id, 's1')).get();
    expect(stub?.homeUserId).toBeNull();
  });

  it('still binds a stub by username hint when nothing here carries the id', async () => {
    insertStub('s1', 'bob@orbit.test', 'orbit.test', null);
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    expect(resolveOrCreateReplicatedUser('r1', 'orbit.test', testDb, { username: 'bob' })?.id).toBe('s1');
  });

  it('tells apart two remote users that share a home user id', async () => {
    insertStub('s-orbit', 'x@orbit.test', 'orbit.test', 'shared');
    insertStub('s-nova', 'y@nova.test', 'nova.test', 'shared');
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    expect(resolveOrCreateReplicatedUser('shared', 'nova.test', testDb)?.id).toBe('s-nova');
    expect(resolveOrCreateReplicatedUser('shared', 'https://orbit.test', testDb)?.id).toBe('s-orbit');
  });

  it('still creates a stub for a remote identity nobody here carries', async () => {
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const created = resolveOrCreateReplicatedUser('r2', 'orbit.test', testDb, { username: 'carol' });
    expect(created?.homeUserId).toBe('r2');
    expect(created?.homeInstance).toBe('orbit.test');
  });
});

describe('findFederatedUser: identity is homeUserId + homeInstance', () => {
  it('finds nothing for a native id named as homed on another instance', async () => {
    insertNative('n1', 'bob');
    const { findFederatedUser } = await import('./federation.js');
    expect(findFederatedUser('n1', 'orbit.test', testDb, { username: 'bob' })).toBeUndefined();
  });
});

describe('attributionRefusal: the actor must not be another identity\'s id here', () => {
  it('refuses an actor claimed by the signing peer whose id is a native user of this instance', async () => {
    insertNative('n1', 'bob');
    const { attributionRefusal } = await import('./federation.js');
    expect(attributionRefusal({ homeUserId: 'n1', homeInstance: 'orbit.test' }, 'https://orbit.test', testDb))
      .toBe('attribution_mismatch');
  });

  it('accepts an actor of the signing peer that is known here or not known yet', async () => {
    insertStub('s1', 'alice@orbit.test', 'orbit.test', 'a1');
    const { attributionRefusal } = await import('./federation.js');
    expect(attributionRefusal({ homeUserId: 'a1', homeInstance: 'orbit.test' }, 'https://orbit.test', testDb)).toBeNull();
    expect(attributionRefusal({ homeUserId: 'new-1', homeInstance: 'orbit.test' }, 'https://orbit.test', testDb)).toBeNull();
  });
});
