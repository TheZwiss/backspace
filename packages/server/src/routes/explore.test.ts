import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same module-level pattern as social.test.ts: the db mock closes over the
// current binding, so each describe's beforeEach reassigns it.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const CALLER_ID = 'caller-user-id';
const OWNER_ID = 'owner-user-id';

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
    sendToSpace: vi.fn(),
    addUserSpace: vi.fn(),
  },
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(id: string, username: string): void {
  testDb.insert(schema.users).values({
    id,
    username,
    passwordHash: 'x',
    status: 'offline',
    isAdmin: 0,
    createdAt: Date.now(),
  }).run();
}

function seedSpace(id: string, visibility: 'public' | 'request' | 'private'): void {
  testDb.insert(schema.spaces).values({
    id,
    name: `Space ${id}`,
    ownerId: OWNER_ID,
    inviteCode: `inv-${id}`,
    visibility,
    createdAt: Date.now(),
  }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: id, userId: OWNER_ID, joinedAt: Date.now() }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { exploreRoutes } = await import('./explore.js');
  await app.register(exploreRoutes);
  await app.ready();
  return app;
}

describe('explore routes — error codes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedUser(CALLER_ID, 'caller');
    seedUser(OWNER_ID, 'owner');
    app = await buildApp();
  });

  it('sends space_not_found with the legacy text for an unknown space', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/spaces/nope/public-join' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('space_not_found');
    expect(body.error).toBe('Space not found');
  });

  it('sends space_not_public when joining a space that is not public', async () => {
    seedSpace('s1', 'request');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s1/public-join' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('space_not_public');
  });

  it('sends user_banned when a banned user tries to join', async () => {
    seedSpace('s1', 'public');
    testDb.insert(schema.bans).values({
      spaceId: 's1', userId: CALLER_ID, bannedBy: OWNER_ID, createdAt: Date.now(),
    }).run();
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s1/public-join' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('user_banned');
  });

  it('sends already_member when the caller is already in the space', async () => {
    seedSpace('s1', 'public');
    testDb.insert(schema.spaceMembers).values({ spaceId: 's1', userId: CALLER_ID, joinedAt: Date.now() }).run();
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s1/public-join' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('already_member');
  });

  it('sends space_not_requestable and join_request_pending on request-join', async () => {
    seedSpace('pub', 'public');
    const notRequestable = await app.inject({ method: 'POST', url: '/api/spaces/pub/request-join', payload: {} });
    expect(notRequestable.statusCode).toBe(403);
    expect(JSON.parse(notRequestable.body).code).toBe('space_not_requestable');

    seedSpace('req', 'request');
    expect((await app.inject({ method: 'POST', url: '/api/spaces/req/request-join', payload: {} })).statusCode).toBe(201);
    const pending = await app.inject({ method: 'POST', url: '/api/spaces/req/request-join', payload: {} });
    expect(pending.statusCode).toBe(409);
    expect(JSON.parse(pending.body).code).toBe('join_request_pending');
  });

  it('sends missing_permission with the permission name when listing join requests', async () => {
    seedSpace('s1', 'request');
    const res = await app.inject({ method: 'GET', url: '/api/spaces/s1/join-requests' });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('missing_permission');
    expect(body.details).toEqual({ permission: 'MANAGE_SPACE' });
    expect(body.error).toBe('Missing MANAGE_SPACE permission');
  });

  it('sends validation_failed for a bad action', async () => {
    seedSpace('s1', 'request');
    const res = await app.inject({ method: 'PATCH', url: '/api/spaces/s1/join-requests/r1', payload: { action: 'maybe' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('validation_failed');
  });

  it('sends join_request_not_found and join_request_decided to a manager', async () => {
    seedSpace('s1', 'request');
    testDb.update(schema.spaces).set({ ownerId: CALLER_ID }).run();
    const missing = await app.inject({ method: 'PATCH', url: '/api/spaces/s1/join-requests/nope', payload: { action: 'decline' } });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).code).toBe('join_request_not_found');

    testDb.insert(schema.joinRequests).values({
      id: 'jr1', spaceId: 's1', userId: OWNER_ID, status: 'declined', createdAt: Date.now(),
    }).run();
    const decided = await app.inject({ method: 'PATCH', url: '/api/spaces/s1/join-requests/jr1', payload: { action: 'decline' } });
    expect(decided.statusCode).toBe(400);
    expect(JSON.parse(decided.body).code).toBe('join_request_decided');
  });
});
