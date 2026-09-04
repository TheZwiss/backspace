import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signJwt } from '../utils/auth.js';

setWorkerId(11);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;
let tusTmpDir: string;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../config.js', async () => {
  const real = await import('../config.js');
  return {
    config: new Proxy(real.config, {
      get(target, prop: string) {
        if (prop === 'tusUploadDir') return tusTmpDir;
        return (target as Record<string, unknown>)[prop];
      },
    }),
  };
});

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
  const { adminRoutes } = await import('./admin.js');
  const f = Fastify();
  await f.register(adminRoutes);
  return f;
}

const ADMIN_ID = 'admin-1';
const USER_ID = 'user-1';
const ADMIN_USERNAME = 'admin';
const USER_USERNAME = 'normie';

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  testDb.insert(schema.users).values([
    {
      id: ADMIN_ID,
      username: ADMIN_USERNAME,
      passwordHash: 'x',
      isAdmin: 1,
      createdAt: Date.now(),
    },
    {
      id: USER_ID,
      username: USER_USERNAME,
      passwordHash: 'x',
      isAdmin: 0,
      createdAt: Date.now(),
    },
  ]).run();

  tusTmpDir = path.join(os.tmpdir(), `backspace-admin-tus-${crypto.randomBytes(8).toString('hex')}`);
  app = await buildApp();
});

afterEach(() => {
  if (fs.existsSync(tusTmpDir)) {
    fs.rmSync(tusTmpDir, { recursive: true, force: true });
  }
});

function adminToken(): string {
  return signJwt({ userId: ADMIN_ID, username: ADMIN_USERNAME });
}

function userToken(): string {
  return signJwt({ userId: USER_ID, username: USER_USERNAME });
}

describe('POST /api/admin/storage/cleanup-tus', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup-tus',
      payload: { maxAgeHours: 1, dryRun: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-admin requests with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup-tus',
      headers: { Authorization: `Bearer ${userToken()}` },
      payload: { maxAgeHours: 1, dryRun: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when maxAgeHours is zero', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup-tus',
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { maxAgeHours: 0, dryRun: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when maxAgeHours is negative', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup-tus',
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { maxAgeHours: -3, dryRun: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when maxAgeHours is NaN/non-finite', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup-tus',
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { maxAgeHours: 'banana', dryRun: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns CleanupResult shape with zeros when .tus/ is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup-tus',
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { maxAgeHours: 1, dryRun: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      dryRun: false,
      deletedFiles: 0,
      freedBytes: 0,
      deletedAttachmentRecords: 0,
      errors: [],
    });
  });

  it('dryRun=true returns counts without unlinking', async () => {
    fs.mkdirSync(tusTmpDir, { recursive: true });
    const stale = path.join(tusTmpDir, 'stale-session');
    fs.writeFileSync(stale, 'x'.repeat(64));
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(stale, twoHoursAgo / 1000, twoHoursAgo / 1000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup-tus',
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { maxAgeHours: 1, dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.deletedFiles).toBe(1);
    expect(body.freedBytes).toBe(64);
    expect(fs.existsSync(stale)).toBe(true);
  });

  it('dryRun=false unlinks stale entries', async () => {
    fs.mkdirSync(tusTmpDir, { recursive: true });
    const stale = path.join(tusTmpDir, 'stale-session');
    fs.writeFileSync(stale, 'y'.repeat(128));
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    fs.utimesSync(stale, threeHoursAgo / 1000, threeHoursAgo / 1000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup-tus',
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { maxAgeHours: 1, dryRun: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(false);
    expect(body.deletedFiles).toBe(1);
    expect(body.freedBytes).toBe(128);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('defaults maxAgeHours to 1 when omitted', async () => {
    fs.mkdirSync(tusTmpDir, { recursive: true });
    const stale = path.join(tusTmpDir, 'stale-90min');
    fs.writeFileSync(stale, 'z'.repeat(32));
    const ninetyMinAgo = Date.now() - 90 * 60 * 1000;
    fs.utimesSync(stale, ninetyMinAgo / 1000, ninetyMinAgo / 1000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup-tus',
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deletedFiles).toBe(1);
  });
});

describe('error codes on the admin routes', () => {
  it('rejects a non-boolean isAdmin with field_not_boolean', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${USER_ID}/role`,
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { isAdmin: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'field_not_boolean', details: { field: 'isAdmin' }, statusCode: 400 });
  });

  it('reports an unknown user with user_not_found', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users/nobody/role',
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { isAdmin: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'user_not_found', error: 'User not found' });
  });

  it('refuses to demote the last admin with last_admin_cannot_be_demoted', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${ADMIN_ID}/role`,
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { isAdmin: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'last_admin_cannot_be_demoted', error: 'Cannot demote the last admin' });
  });

  it('refuses to promote a federated user with federated_user_cannot_be_admin', async () => {
    testDb.update(schema.users).set({ homeInstance: 'remote.example' }).where(eq(schema.users.id, USER_ID)).run();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${USER_ID}/role`,
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { isAdmin: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('federated_user_cannot_be_admin');
  });

  it('refuses to reset a federated password with federated_user_password_managed_by_home', async () => {
    testDb.update(schema.users).set({ homeInstance: 'remote.example' }).where(eq(schema.users.id, USER_ID)).run();
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${USER_ID}/reset-password`,
      headers: { Authorization: `Bearer ${adminToken()}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('federated_user_password_managed_by_home');
  });

  it("refuses to reset a deleted user's password with deleted_user_password_reset", async () => {
    testDb.update(schema.users).set({ isDeleted: 1 }).where(eq(schema.users.id, USER_ID)).run();
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${USER_ID}/reset-password`,
      headers: { Authorization: `Bearer ${adminToken()}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('deleted_user_password_reset');
  });

  it('refuses self-deletion with admin_cannot_delete_self', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${ADMIN_ID}`,
      headers: { Authorization: `Bearer ${adminToken()}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('admin_cannot_delete_self');
  });

  it('refuses to delete a space owner with user_owns_spaces and still lists the spaces', async () => {
    testDb.insert(schema.spaces).values({ id: 'space-1', name: 'Owned', ownerId: USER_ID, createdAt: Date.now() }).run();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${USER_ID}`,
      headers: { Authorization: `Bearer ${adminToken()}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'user_owns_spaces',
      statusCode: 400,
      ownedSpaces: [{ id: 'space-1', name: 'Owned' }],
    });
  });

  it('rejects a bad maxAgeDays with cleanup_age_invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup-media',
      headers: { Authorization: `Bearer ${adminToken()}` },
      payload: { maxAgeDays: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'cleanup_age_invalid', details: { field: 'maxAgeDays' } });
  });
});
