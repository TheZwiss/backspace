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

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'member';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    addUserSpace: vi.fn(),
    sendToSpace: vi.fn(),
    sendToUser: vi.fn(),
    pushReadyPayload: vi.fn(),
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

const OWNER_ID = 'owner';
const SPACE_ID = 'space-1';
const INVITE_CODE = 'code-1';
const now = 1_700_000_000_000;

async function buildApp(): Promise<FastifyInstance> {
  const { spaceRoutes } = await import('./spaces.js');
  const f = Fastify();
  await f.register(spaceRoutes);
  return f;
}

let app: FastifyInstance;

interface ErrorBody {
  error: string;
  code?: string;
  statusCode: number;
  details?: Record<string, string | number>;
}

function addMember(userId: string): void {
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId, joinedAt: now }).run();
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  currentUserId = 'member';

  for (const id of [OWNER_ID, 'member', 'outsider']) {
    testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: now }).run();
  }
  testDb.insert(schema.spaces).values({
    id: SPACE_ID,
    name: 'Space',
    ownerId: OWNER_ID,
    inviteCode: INVITE_CODE,
    visibility: 'public',
    createdAt: now,
  }).run();
  addMember(OWNER_ID);
  addMember('member');

  app = await buildApp();
});

describe('space routes send stable error codes', () => {
  it('space_name_required when creating a space without a name', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/spaces', payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json<ErrorBody>();
    expect(body.code).toBe('space_name_required');
    expect(body.error).toBe('Space name is required');
    expect(body.statusCode).toBe(400);
  });

  it('space_name_length carries the limits as details', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/spaces', payload: { name: 'x'.repeat(101) } });
    expect(res.statusCode).toBe(400);
    const body = res.json<ErrorBody>();
    expect(body.code).toBe('space_name_length');
    expect(body.details).toEqual({ min: 1, max: 100 });
    expect(body.error).toBe('Space name must be between 1 and 100 characters');
  });

  it('space_not_found for an unknown space id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spaces/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorBody>().code).toBe('space_not_found');
  });

  it('not_space_member when a non-member reads a space', async () => {
    currentUserId = 'outsider';
    const res = await app.inject({ method: 'GET', url: `/api/spaces/${SPACE_ID}` });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().code).toBe('not_space_member');
  });

  it('missing_permission names the permission in details', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}`, payload: { name: 'Renamed' } });
    expect(res.statusCode).toBe(403);
    const body = res.json<ErrorBody>();
    expect(body.code).toBe('missing_permission');
    expect(body.details).toEqual({ permission: 'MANAGE_SPACE' });
    expect(body.error).toBe('Missing MANAGE_SPACE permission');
  });

  it('space_owner_only when a member tries to delete the space', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}` });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().code).toBe('space_owner_only');
  });

  it('invite_not_found for a wrong invite code on join', async () => {
    currentUserId = 'outsider';
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/join`, payload: { inviteCode: 'wrong' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().code).toBe('invite_not_found');
  });

  it('already_member keeps the text older clients match on', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/join`, payload: { inviteCode: INVITE_CODE } });
    expect(res.statusCode).toBe(409);
    const body = res.json<ErrorBody>();
    expect(body.code).toBe('already_member');
    expect(body.error).toMatch(/already a member/i);
  });

  it('user_id_required when banning without a user', async () => {
    currentUserId = OWNER_ID;
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/bans`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().code).toBe('user_id_required');
  });

  it('cannot_target_owner when the owner is the ban target', async () => {
    currentUserId = OWNER_ID;
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/bans`, payload: { userId: OWNER_ID } });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().code).toBe('cannot_target_owner');
  });
});
