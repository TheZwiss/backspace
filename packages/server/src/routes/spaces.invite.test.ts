import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@backspace/shared/src/permissions.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(8);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;
let authedUserId = 'attacker-1';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = authedUserId;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    addUserSpace: vi.fn(),
    sendToSpace: vi.fn(),
  },
}));

vi.mock('../ws/events.js', () => ({
  checkVoicePermissions: vi.fn(),
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter((f: string) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sqlText.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const { spaceRoutes } = await import('./spaces.js');
  const f = Fastify();
  await f.register(spaceRoutes);
  return f;
}

function seedInviteFixture(): void {
  const now = Date.now();
  testDb.insert(schema.users).values([
    { id: 'owner-1', username: 'owner', passwordHash: 'x', createdAt: now },
    { id: 'attacker-1', username: 'attacker', passwordHash: 'x', createdAt: now },
  ]).run();
  testDb.insert(schema.spaces).values({
    id: 'space-1',
    name: 'Invite Test Space',
    ownerId: 'owner-1',
    visibility: 'public',
    createdAt: now,
  }).run();
  testDb.insert(schema.spaceMembers).values({
    spaceId: 'space-1',
    userId: 'owner-1',
    joinedAt: now,
  }).run();
  testDb.insert(schema.roles).values({
    id: 'space-1',
    spaceId: 'space-1',
    name: '@everyone',
    permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
    createdAt: now,
  }).run();
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  authedUserId = 'attacker-1';
  seedInviteFixture();
  app = await buildApp();
});

describe('POST /api/spaces/:id/invite', () => {
  it('rejects non-members even when @everyone grants CREATE_INVITE', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/spaces/space-1/invite' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'Space membership required', statusCode: 403 });
  });

  it('allows a member with CREATE_INVITE to get an invite code', async () => {
    authedUserId = 'owner-1';

    const res = await app.inject({ method: 'POST', url: '/api/spaces/space-1/invite' });

    expect(res.statusCode).toBe(200);
    expect(res.json().inviteCode).toMatch(/^[0-9a-f]{8}$/);
  });

  it('allows an instance admin who is not a space member to get an invite code', async () => {
    testDb.update(schema.users)
      .set({ isAdmin: 1 })
      .where(eq(schema.users.id, 'attacker-1'))
      .run();

    const res = await app.inject({ method: 'POST', url: '/api/spaces/space-1/invite' });

    expect(res.statusCode).toBe(200);
    expect(res.json().inviteCode).toMatch(/^[0-9a-f]{8}$/);
  });
});
