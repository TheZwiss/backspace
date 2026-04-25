import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const CALLER_ID = 'caller-user-id';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = CALLER_ID;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToAdmins: vi.fn(),
    sendToDmMembers: vi.fn(),
    getAllOnlineUserIds: () => [],
  },
}));

vi.mock('../utils/federationOutbox.js', () => ({
  appendMutationLog: vi.fn(),
  queueOutboxEvent: vi.fn(),
  buildFriendContextId: () => 'ctx',
  getFriendEventTargets: () => [],
}));

vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://local.test',
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sqlText.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

interface UserSeed {
  id: string;
  username: string;
  displayName?: string | null;
  isDeleted?: 0 | 1;
  discoverable?: 0 | 1;
  homeInstance?: string | null;
  homeUserId?: string | null;
}

function seedUser(u: UserSeed): void {
  testDb.insert(schema.users).values({
    id: u.id,
    username: u.username,
    displayName: u.displayName ?? null,
    passwordHash: 'x',
    status: 'offline',
    isAdmin: 0,
    isDeleted: u.isDeleted ?? 0,
    discoverable: u.discoverable ?? 1,
    homeInstance: u.homeInstance ?? null,
    homeUserId: u.homeUserId ?? null,
    createdAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { socialRoutes } = await import('./social.js');
  await app.register(socialRoutes);
  await app.ready();
  return app;
}

describe('GET /api/social/search — filter hygiene', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    // The caller themselves must exist so self-exclusion is meaningful.
    seedUser({ id: CALLER_ID, username: 'caller' });
    app = await buildApp();
  });

  async function search(q: string) {
    const res = await app.inject({ method: 'GET', url: `/api/social/search?q=${encodeURIComponent(q)}` });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Array<{ id: string; username: string }>;
  }

  it('returns native, non-deleted, discoverable users that match the substring', async () => {
    seedUser({ id: 'u1', username: 'alice', displayName: 'Alice' });
    const out = await search('ali');
    expect(out.map(u => u.id)).toContain('u1');
  });

  it('hides tombstoned users (isDeleted=1)', async () => {
    seedUser({ id: 'u1', username: 'alice', displayName: 'Alice', isDeleted: 1 });
    const out = await search('ali');
    expect(out.map(u => u.id)).not.toContain('u1');
  });

  it('hides replicated federated stubs (homeInstance set)', async () => {
    // Stub username matches the production form: <homeUserId>@<domain>.
    seedUser({
      id: 'stub1',
      username: 'remote-id@nova.ddns.net',
      displayName: null,
      homeInstance: 'nova.ddns.net',
      homeUserId: 'remote-id',
    });
    const out = await search('nova');
    expect(out.map(u => u.id)).not.toContain('stub1');
  });

  it('hides users with discoverable=0', async () => {
    seedUser({ id: 'u1', username: 'alice', discoverable: 0 });
    const out = await search('ali');
    expect(out.map(u => u.id)).not.toContain('u1');
  });

  it('excludes the caller from results', async () => {
    // Caller is seeded in beforeEach with username 'caller'.
    const out = await search('call');
    expect(out.map(u => u.id)).not.toContain(CALLER_ID);
  });

  it('matches displayName as well as username', async () => {
    seedUser({ id: 'u1', username: 'a1b2c3', displayName: 'Wonderland' });
    const out = await search('wonder');
    expect(out.map(u => u.id)).toContain('u1');
  });
});

describe('POST /api/social/requests — case-insensitive username lookup', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedUser({ id: CALLER_ID, username: 'caller' });
    // Target stored canonically lowercase, as registration would write it.
    seedUser({ id: 'target-id', username: 'bob' });
    app = await buildApp();
  });

  async function sendRequest(username: string) {
    return app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username },
    });
  }

  it('finds the target when the caller types the exact stored handle', async () => {
    const res = await sendRequest('bob');
    expect(res.statusCode).toBe(201);
    const inserted = testDb.select().from(schema.friendRequests)
      .where(eq(schema.friendRequests.toId, 'target-id')).get();
    expect(inserted).toBeTruthy();
  });

  it('finds the target when the caller types a mixed-case handle', async () => {
    const res = await sendRequest('Bob');
    expect(res.statusCode).toBe(201);
    const inserted = testDb.select().from(schema.friendRequests)
      .where(eq(schema.friendRequests.toId, 'target-id')).get();
    expect(inserted).toBeTruthy();
  });

  it('finds the target when the caller types an all-uppercase handle', async () => {
    const res = await sendRequest('BOB');
    expect(res.statusCode).toBe(201);
  });

  it('trims surrounding whitespace before lookup', async () => {
    const res = await sendRequest('  bob  ');
    expect(res.statusCode).toBe(201);
  });

  it('returns 404 when the handle does not exist', async () => {
    const res = await sendRequest('nobody');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('User not found');
  });
});
