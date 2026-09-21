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
import { markDirectoryDirty } from '../directory/state.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const OWNER_ID = 'owner';
const SPACE_ID = 'space-1';
const now = 1_700_000_000_000;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

// Every request runs as the space owner: the listing flag follows the same
// MANAGE_SPACE rule as visibility, and the owner always passes it.
vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = OWNER_ID;
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

vi.mock('../directory/state.js', async (orig) => ({
  ...(await orig<typeof import('../directory/state.js')>()),
  markDirectoryDirty: vi.fn(),
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

async function buildApp(): Promise<FastifyInstance> {
  const { spaceRoutes } = await import('./spaces.js');
  const f = Fastify();
  await f.register(spaceRoutes);
  return f;
}

let app: FastifyInstance;

function seedSpace(visibility: 'public' | 'request' | 'private', directoryListed: 0 | 1): void {
  testDb.insert(schema.spaces).values({
    id: SPACE_ID,
    name: 'Space',
    ownerId: OWNER_ID,
    inviteCode: 'code-1',
    visibility,
    directoryListed,
    createdAt: now,
  }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: OWNER_ID, joinedAt: now }).run();
}

function readSpace(): typeof schema.spaces.$inferSelect | undefined {
  return testDb.select().from(schema.spaces).where(eq(schema.spaces.id, SPACE_ID)).get();
}

async function patchSpace(payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}`, payload });
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  testDb.insert(schema.users).values({ id: OWNER_ID, username: OWNER_ID, passwordHash: 'x', createdAt: now }).run();

  vi.mocked(markDirectoryDirty).mockClear();
  app = await buildApp();
});

describe('PATCH /api/spaces/:id directoryListed', () => {
  it('rejects a non-boolean directoryListed with field_not_boolean', async () => {
    seedSpace('public', 0);
    const res = await patchSpace({ directoryListed: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'field_not_boolean', details: { field: 'directoryListed' } });
    expect(readSpace()?.directoryListed).toBe(0);
  });

  it('rejects directoryListed=true on a private space with directory_private_space', async () => {
    seedSpace('private', 0);
    const res = await patchSpace({ directoryListed: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('directory_private_space');
    expect(readSpace()?.directoryListed).toBe(0);
    expect(markDirectoryDirty).not.toHaveBeenCalled();
  });

  it('rejects directoryListed=true when the same PATCH makes the space private', async () => {
    seedSpace('public', 0);
    const res = await patchSpace({ visibility: 'private', directoryListed: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('directory_private_space');
    expect(readSpace()?.visibility).toBe('public');
  });

  it('accepts directoryListed=true when the same PATCH makes a private space public', async () => {
    seedSpace('private', 0);
    const res = await patchSpace({ visibility: 'public', directoryListed: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().directoryListed).toBe(true);
    expect(readSpace()?.directoryListed).toBe(1);
  });

  it('lists a public space, reports it in the response and marks dirty', async () => {
    seedSpace('public', 0);
    const res = await patchSpace({ directoryListed: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().directoryListed).toBe(true);
    expect(readSpace()?.directoryListed).toBe(1);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('lists a request-only space', async () => {
    seedSpace('request', 0);
    const res = await patchSpace({ directoryListed: true });
    expect(res.statusCode).toBe(200);
    expect(readSpace()?.directoryListed).toBe(1);
  });

  it('unlisting marks dirty', async () => {
    seedSpace('public', 1);
    const res = await patchSpace({ directoryListed: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().directoryListed).toBe(false);
    expect(readSpace()?.directoryListed).toBe(0);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('switching a listed space to private clears the flag and marks dirty', async () => {
    seedSpace('public', 1);
    const res = await patchSpace({ visibility: 'private' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ visibility: 'private', directoryListed: false });
    expect(readSpace()?.directoryListed).toBe(0);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('marks dirty when a listed space changes a served field', async () => {
    seedSpace('public', 1);
    const res = await patchSpace({ name: 'Renamed', description: 'New blurb' });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('marks dirty when a listed space moves between public and request', async () => {
    seedSpace('public', 1);
    const res = await patchSpace({ visibility: 'request' });
    expect(res.statusCode).toBe(200);
    expect(readSpace()?.directoryListed).toBe(1);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('does not mark when an unlisted space changes a served field', async () => {
    seedSpace('public', 0);
    const res = await patchSpace({ name: 'Renamed' });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).not.toHaveBeenCalled();
  });

  it('does not mark when the PATCH repeats the stored values', async () => {
    seedSpace('public', 1);
    const res = await patchSpace({ directoryListed: true, name: 'Space', visibility: 'public' });
    expect(res.statusCode).toBe(200);
    expect(res.json().directoryListed).toBe(true);
    expect(markDirectoryDirty).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/spaces/:id', () => {
  it('marks dirty when the deleted space was listed', async () => {
    seedSpace('public', 1);
    const res = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}` });
    expect(res.statusCode).toBe(200);
    expect(readSpace()).toBeUndefined();
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('does not mark when the deleted space was not listed', async () => {
    seedSpace('public', 0);
    const res = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}` });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).not.toHaveBeenCalled();
  });
});

describe('Space.directoryListed projection', () => {
  it('GET /api/spaces/:id reports a listed space as listed', async () => {
    seedSpace('public', 1);
    const res = await app.inject({ method: 'GET', url: `/api/spaces/${SPACE_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().directoryListed).toBe(true);
  });

  it('GET /api/spaces reports an unlisted space as unlisted', async () => {
    seedSpace('public', 0);
    const res = await app.inject({ method: 'GET', url: '/api/spaces' });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].directoryListed).toBe(false);
  });
});
