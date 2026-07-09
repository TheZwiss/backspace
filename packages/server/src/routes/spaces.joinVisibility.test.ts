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
let currentUserId = 'joiner';

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
const now = 1_700_000_000_000;

async function buildApp(): Promise<FastifyInstance> {
  const { spaceRoutes } = await import('./spaces.js');
  const f = Fastify();
  await f.register(spaceRoutes);
  return f;
}

let app: FastifyInstance;

function makeSpace(id: string, visibility: 'public' | 'request' | 'private', inviteCode: string): void {
  testDb.insert(schema.spaces).values({
    id,
    name: `space-${visibility}`,
    ownerId: OWNER_ID,
    inviteCode,
    visibility,
    createdAt: now,
  }).run();
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  currentUserId = 'joiner';

  for (const id of [OWNER_ID, 'joiner']) {
    testDb.insert(schema.users).values({
      id, username: id, passwordHash: 'x', createdAt: now,
    }).run();
  }

  app = await buildApp();
});

function isMember(spaceId: string, userId: string): boolean {
  return testDb.select().from(schema.spaceMembers).all()
    .some(m => m.spaceId === spaceId && m.userId === userId);
}

describe('POST /api/spaces/:id/join — visibility guard', () => {
  it('rejects an invite-code join for a request-only space (approval required)', async () => {
    makeSpace('s-req', 'request', 'code-req');
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/s-req/join',
      payload: { inviteCode: 'code-req' },
    });
    expect(res.statusCode).toBe(403);
    expect(isMember('s-req', 'joiner')).toBe(false);
  });

  it('allows an invite-code join for a private space (invite is the only entry path)', async () => {
    makeSpace('s-priv', 'private', 'code-priv');
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/s-priv/join',
      payload: { inviteCode: 'code-priv' },
    });
    expect(res.statusCode).toBe(200);
    expect(isMember('s-priv', 'joiner')).toBe(true);
  });

  it('allows an invite-code join for a public space', async () => {
    makeSpace('s-pub', 'public', 'code-pub');
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/s-pub/join',
      payload: { inviteCode: 'code-pub' },
    });
    expect(res.statusCode).toBe(200);
    expect(isMember('s-pub', 'joiner')).toBe(true);
  });
});

describe('POST /api/spaces/join (codeless) — visibility guard', () => {
  it('rejects an invite-code join for a request-only space', async () => {
    makeSpace('s-req2', 'request', 'code-req2');
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/join',
      payload: { inviteCode: 'code-req2' },
    });
    expect(res.statusCode).toBe(403);
    expect(isMember('s-req2', 'joiner')).toBe(false);
  });

  it('allows an invite-code join for a private space', async () => {
    makeSpace('s-priv2', 'private', 'code-priv2');
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/join',
      payload: { inviteCode: 'code-priv2' },
    });
    expect(res.statusCode).toBe(200);
    expect(isMember('s-priv2', 'joiner')).toBe(true);
  });
});

describe('POST /api/spaces/:id/invite — visibility guard', () => {
  // Caller is the owner (a member with CREATE_INVITE) so we exercise the
  // visibility guard, not the permission/membership gate.
  it('refuses to mint/return an invite code for a request-only space', async () => {
    currentUserId = OWNER_ID;
    makeSpace('s-req-inv', 'request', 'code-req-inv');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s-req-inv/invite' });
    expect(res.statusCode).toBe(403);
  });

  it('returns an invite code for a private space', async () => {
    currentUserId = OWNER_ID;
    makeSpace('s-priv-inv', 'private', 'code-priv-inv');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s-priv-inv/invite' });
    expect(res.statusCode).toBe(200);
    expect(res.json().inviteCode).toBe('code-priv-inv');
  });

  it('returns an invite code for a public space', async () => {
    currentUserId = OWNER_ID;
    makeSpace('s-pub-inv', 'public', 'code-pub-inv');
    const res = await app.inject({ method: 'POST', url: '/api/spaces/s-pub-inv/invite' });
    expect(res.statusCode).toBe(200);
    expect(res.json().inviteCode).toBe('code-pub-inv');
  });
});
