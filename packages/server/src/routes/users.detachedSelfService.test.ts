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
import { signJwt, hashPassword, verifyPassword } from '../utils/auth.js';
import { sanitizeUser } from '../utils/sanitize.js';

setWorkerId(23);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

// Federation relay is disabled in these tests (no peers seeded) — but the PATCH
// handler's S2S block is also gated on `!homeInstance`, so detached/federated
// accounts never relay regardless. The ws layer is fully mocked.
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    setUserShowActivity: vi.fn(),
    clearUserActivities: vi.fn(),
    getUserStatus: vi.fn(() => 'online'),
    forceDisconnectUser: vi.fn(),
  },
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const { userRoutes } = await import('./users.js');
  const f = Fastify({ logger: false });
  await f.register(userRoutes);
  await f.ready();
  return f;
}

// A REAL federated account whose home domain was reset and has been detached
// (federationHomeOrphaned = 1): sovereign local account, manages profile +
// password locally.
const DETACHED_ID = 'detached-1';
const DETACHED_USERNAME = 'alice@orbit.test';
const DETACHED_PASSWORD = 'correct-horse-battery';

// A plain replicated (non-detached) federated account — still write-protected
// and still gets the federated change-password bypass.
const FEDERATED_ID = 'federated-1';
const FEDERATED_USERNAME = 'bob@orbit.test';

let detachedHash = '';

async function seedUsers(): Promise<void> {
  detachedHash = await hashPassword(DETACHED_PASSWORD);
  testDb.insert(schema.users).values([
    {
      id: DETACHED_ID,
      username: DETACHED_USERNAME,
      displayName: 'Alice',
      passwordHash: detachedHash,
      status: 'offline',
      isAdmin: 0,
      isDeleted: 0,
      homeInstance: 'orbit.test',
      homeUserId: 'old-home-uid',
      federationHomeOrphaned: 1,
      profileUpdatedAt: 1000,
      createdAt: Date.now(),
    },
    {
      id: FEDERATED_ID,
      username: FEDERATED_USERNAME,
      displayName: 'Bob',
      passwordHash: 'x',
      status: 'offline',
      isAdmin: 0,
      isDeleted: 0,
      homeInstance: 'orbit.test',
      homeUserId: 'bob-home-uid',
      federationHomeOrphaned: 0,
      profileUpdatedAt: 1000,
      createdAt: Date.now(),
    },
  ]).run();
}

function detachedToken(): string {
  return signJwt({ userId: DETACHED_ID, username: DETACHED_USERNAME });
}

function federatedToken(): string {
  return signJwt({ userId: FEDERATED_ID, username: FEDERATED_USERNAME });
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  await seedUsers();
  app = await buildApp();
});

describe('PATCH /api/users/@me — durable-field write-protection', () => {
  it('detached account CAN edit durable profile fields', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/@me',
      headers: { Authorization: `Bearer ${detachedToken()}` },
      payload: { displayName: 'New Name' },
    });

    expect(res.statusCode).toBe(200);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, DETACHED_ID)).get();
    expect(row?.displayName).toBe('New Name');
  });

  it('non-detached federated account still CANNOT edit durable profile fields (403)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/@me',
      headers: { Authorization: `Bearer ${federatedToken()}` },
      payload: { displayName: 'Hijacked' },
    });

    expect(res.statusCode).toBe(403);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, FEDERATED_ID)).get();
    expect(row?.displayName).toBe('Bob'); // unchanged
  });
});

describe('POST /api/users/@me/change-password — local rule for detached accounts', () => {
  it('detached account change-password REQUIRES currentPassword (local rule)', async () => {
    // No currentPassword → 400
    const missing = await app.inject({
      method: 'POST',
      url: '/api/users/@me/change-password',
      headers: { Authorization: `Bearer ${detachedToken()}` },
      payload: { newPassword: 'brand-new-password' },
    });
    expect(missing.statusCode).toBe(400);

    // Wrong currentPassword → 403
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/users/@me/change-password',
      headers: { Authorization: `Bearer ${detachedToken()}` },
      payload: { currentPassword: 'not-the-password', newPassword: 'brand-new-password' },
    });
    expect(wrong.statusCode).toBe(403);

    // Correct currentPassword → 200 and hash actually rotates
    const ok = await app.inject({
      method: 'POST',
      url: '/api/users/@me/change-password',
      headers: { Authorization: `Bearer ${detachedToken()}` },
      payload: { currentPassword: DETACHED_PASSWORD, newPassword: 'brand-new-password' },
    });
    expect(ok.statusCode).toBe(200);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, DETACHED_ID)).get();
    expect(row?.passwordHash).not.toBe(detachedHash);
    await expect(verifyPassword('brand-new-password', row!.passwordHash)).resolves.toBe(true);
  });

  it('non-detached federated account still gets the bypass (no currentPassword → 200)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/@me/change-password',
      headers: { Authorization: `Bearer ${federatedToken()}` },
      payload: { newPassword: 'bob-new-password' },
    });
    expect(res.statusCode).toBe(200);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, FEDERATED_ID)).get();
    await expect(verifyPassword('bob-new-password', row!.passwordHash)).resolves.toBe(true);
  });
});

describe('DELETE /api/users/@me — local rule for detached accounts', () => {
  it('detached self-delete REQUIRES the local password (local rule)', async () => {
    // No password → 400
    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/users/@me',
      headers: { Authorization: `Bearer ${detachedToken()}` },
      payload: { username: DETACHED_USERNAME },
    });
    expect(missing.statusCode).toBe(400);
    expect(testDb.select().from(schema.users).where(eq(schema.users.id, DETACHED_ID)).get()!.isDeleted).toBe(0);

    // Wrong password → 403
    const wrong = await app.inject({
      method: 'DELETE',
      url: '/api/users/@me',
      headers: { Authorization: `Bearer ${detachedToken()}` },
      payload: { username: DETACHED_USERNAME, password: 'not-the-password' },
    });
    expect(wrong.statusCode).toBe(403);
    expect(testDb.select().from(schema.users).where(eq(schema.users.id, DETACHED_ID)).get()!.isDeleted).toBe(0);

    // Correct password → 200 and the account is tombstoned.
    const ok = await app.inject({
      method: 'DELETE',
      url: '/api/users/@me',
      headers: { Authorization: `Bearer ${detachedToken()}` },
      payload: { username: DETACHED_USERNAME, password: DETACHED_PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    expect(testDb.select().from(schema.users).where(eq(schema.users.id, DETACHED_ID)).get()!.isDeleted).toBe(1);
  });

  it('non-detached federated self-delete still works JWT-only (no password required)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/users/@me',
      headers: { Authorization: `Bearer ${federatedToken()}` },
      payload: { username: FEDERATED_USERNAME },
    });
    expect(res.statusCode).toBe(200);
    expect(testDb.select().from(schema.users).where(eq(schema.users.id, FEDERATED_ID)).get()!.isDeleted).toBe(1);
  });
});

describe('sanitizeUser — federationHomeOrphaned is self-view only', () => {
  it('exposes federationHomeOrphaned only on self-view', () => {
    const detachedRow = testDb.select().from(schema.users).where(eq(schema.users.id, DETACHED_ID)).get()!;

    const self = sanitizeUser(detachedRow, true);
    expect(self.federationHomeOrphaned).toBe(true);

    const other = sanitizeUser(detachedRow);
    expect('federationHomeOrphaned' in other).toBe(false);
  });

  it('non-detached self-view reports federationHomeOrphaned false', () => {
    const federatedRow = testDb.select().from(schema.users).where(eq(schema.users.id, FEDERATED_ID)).get()!;
    const self = sanitizeUser(federatedRow, true);
    expect(self.federationHomeOrphaned).toBe(false);
  });

  it('tombstone (deleted) self-view never exposes federationHomeOrphaned', () => {
    testDb.update(schema.users).set({ isDeleted: 1 }).where(eq(schema.users.id, DETACHED_ID)).run();
    const deletedRow = testDb.select().from(schema.users).where(eq(schema.users.id, DETACHED_ID)).get()!;
    const self = sanitizeUser(deletedRow, true);
    expect('federationHomeOrphaned' in self).toBe(false);
  });
});
