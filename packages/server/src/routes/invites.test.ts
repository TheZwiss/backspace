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

// Module-level mutable state. Each describe's beforeEach reassigns
// `sqlite`/`testDb`/`app`; the `getDb: () => testDb` getter in the mock
// closes over the current binding, so reassignment is observed. The
// `callerIsAdmin` flag lets a test flip the admin guard to verify 403s.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;
let callerIsAdmin = true;
const CALLER_ID = 'admin-1';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = CALLER_ID;
  },
  requireAdmin: async (
    _req: { userId?: string },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    if (!callerIsAdmin) {
      return reply.code(403).send({ error: 'Admin required', statusCode: 403 });
    }
  },
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

async function buildApp(): Promise<FastifyInstance> {
  const { invitesRoutes } = await import('./invites.js');
  const f = Fastify();
  await f.register(invitesRoutes);
  return f;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  callerIsAdmin = true;

  testDb.insert(schema.users).values({
    id: CALLER_ID,
    username: 'admin',
    passwordHash: 'x',
    isAdmin: 1,
    createdAt: Date.now(),
  }).run();

  app = await buildApp();
});

describe('POST /api/admin/invites', () => {
  it('creates an invite and returns summary', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'Friends', maxUses: 10, expiresAt: Date.now() + 86_400_000 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('Friends');
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.status).toBe('active');
    expect(body.url).toContain('/register?invite=');
  });

  it('rejects empty name with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: '', maxUses: null, expiresAt: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for non-admin', async () => {
    callerIsAdmin = false;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'x', maxUses: null, expiresAt: null },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/admin/invites', () => {
  it('returns active invites by default', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: null, expiresAt: null },
    });
    const res = await app.inject({ method: 'GET', url: '/api/admin/invites' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].name).toBe('a');
  });

  it('returns archived invites with status=archived', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: null, expiresAt: null },
    });
    const id = created.json().id;
    await app.inject({ method: 'POST', url: `/api/admin/invites/${id}/revoke` });

    const active = await app.inject({ method: 'GET', url: '/api/admin/invites?status=active' });
    expect(active.json().invites).toHaveLength(0);

    const archived = await app.inject({ method: 'GET', url: '/api/admin/invites?status=archived' });
    expect(archived.json().invites).toHaveLength(1);
    expect(archived.json().invites[0].status).toBe('revoked');
  });

  it('createdByUsername surfaces "Deleted User" after admin tombstone', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: null, expiresAt: null },
    });
    // Tombstone the admin who created the invite. The list endpoint uses a
    // LEFT JOIN against users; foldUsername should map isDeleted=1 to
    // 'Deleted User'. This exercises the JOIN-based code path, not the
    // per-row resolveCreatorUsername fallback.
    testDb.update(schema.users)
      .set({ isDeleted: 1, username: '!deleted:' + CALLER_ID })
      .where(eq(schema.users.id, CALLER_ID))
      .run();

    const res = await app.inject({ method: 'GET', url: '/api/admin/invites' });
    expect(res.json().invites[0].createdByUsername).toBe('Deleted User');
  });
});

describe('PATCH /api/admin/invites/:id', () => {
  it('updates name', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'old', maxUses: null, expiresAt: null },
    });
    const id = created.json().id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/invites/${id}`,
      payload: { name: 'new' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('new');
  });

  it('returns 409 for revoked invite', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: null, expiresAt: null },
    });
    const id = created.json().id;
    await app.inject({ method: 'POST', url: `/api/admin/invites/${id}/revoke` });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/invites/${id}`,
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 for missing id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/invites/nope',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/admin/invites/:id/revoke', () => {
  it('revokes and returns summary', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: null, expiresAt: null },
    });
    const id = created.json().id;
    const res = await app.inject({ method: 'POST', url: `/api/admin/invites/${id}/revoke` });
    expect(res.statusCode).toBe(200);
    expect(res.json().invite.status).toBe('revoked');
  });

  it('returns 409 on already-revoked', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: null, expiresAt: null },
    });
    const id = created.json().id;
    await app.inject({ method: 'POST', url: `/api/admin/invites/${id}/revoke` });
    const res = await app.inject({ method: 'POST', url: `/api/admin/invites/${id}/revoke` });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/admin/invites/:id/reinstate', () => {
  it('rotates token on revoked path', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: 1, expiresAt: null },
    });
    const id = created.json().id;
    const originalToken = created.json().token;
    await app.inject({ method: 'POST', url: `/api/admin/invites/${id}/revoke` });

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/invites/${id}/reinstate`,
      payload: { maxUses: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokenRotated).toBe(true);
    expect(body.invite.token).not.toBe(originalToken);
    expect(body.invite.status).toBe('active');
  });

  it('preserves token on exhausted path', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: 1, expiresAt: null },
    });
    const id = created.json().id;
    const originalToken = created.json().token;
    // Force the row to exhausted by bumping usedCount to maxUses.
    testDb.update(schema.inviteLinks)
      .set({ usedCount: 1 })
      .where(eq(schema.inviteLinks.id, id))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/invites/${id}/reinstate`,
      payload: { maxUses: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokenRotated).toBe(false);
    expect(res.json().invite.token).toBe(originalToken);
  });

  it('returns 409 on already-active', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: null, expiresAt: null },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/invites/${created.json().id}/reinstate`,
      payload: { maxUses: 100 },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('DELETE /api/admin/invites/:id', () => {
  it('hard-deletes and cascades redemptions', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: null, expiresAt: null },
    });
    const id = created.json().id;
    testDb.insert(schema.inviteRedemptions).values({
      id: 'r1',
      inviteId: id,
      userId: null,
      registrantUsername: 'g',
      redeemedAt: Date.now(),
    }).run();

    const res = await app.inject({ method: 'DELETE', url: `/api/admin/invites/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(
      testDb.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, id)).get(),
    ).toBeUndefined();
    expect(
      testDb.select().from(schema.inviteRedemptions).where(eq(schema.inviteRedemptions.inviteId, id)).all(),
    ).toHaveLength(0);
  });
});

describe('GET /api/admin/invites/:id/redemptions', () => {
  it('returns redemption list', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { name: 'a', maxUses: null, expiresAt: null },
    });
    const id = created.json().id;
    testDb.insert(schema.users).values({
      id: 'u1',
      username: 'alice',
      passwordHash: 'x',
      createdAt: Date.now(),
    }).run();
    testDb.insert(schema.inviteRedemptions).values({
      id: 'r1',
      inviteId: id,
      userId: 'u1',
      registrantUsername: 'alice',
      redeemedAt: Date.now(),
    }).run();

    const res = await app.inject({ method: 'GET', url: `/api/admin/invites/${id}/redemptions` });
    expect(res.statusCode).toBe(200);
    expect(res.json().redemptions).toHaveLength(1);
    expect(res.json().redemptions[0].registrantUsername).toBe('alice');
    expect(res.json().redemptions[0].currentUsername).toBe('alice');
  });
});
