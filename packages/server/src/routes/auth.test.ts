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

setWorkerId(2);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level mutable state — see invites.test.ts for the rationale on why
// the `getDb` mock closes over a getter rather than the binding directly.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
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
  const { authRoutes } = await import('./auth.js');
  const f = Fastify();
  await f.register(authRoutes);
  return f;
}

const ADMIN_ID = 'admin-1';

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  // The invite_links rows we'll create reference users(id) via createdBy. Seed
  // a single admin to act as creator across all tests.
  testDb.insert(schema.users).values({
    id: ADMIN_ID,
    username: 'admin',
    passwordHash: 'x',
    isAdmin: 1,
    createdAt: Date.now(),
  }).run();

  app = await buildApp();
});

describe('GET /api/auth/check-invite', () => {
  it('returns valid: true with name for active token', async () => {
    const token = 'a'.repeat(22);
    testDb.insert(schema.inviteLinks).values({
      id: 'inv-1',
      token,
      name: 'Friends batch 1',
      createdBy: ADMIN_ID,
      createdAt: Date.now(),
      maxUses: 10,
      usedCount: 0,
      expiresAt: null,
      revokedAt: null,
    }).run();

    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/check-invite?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.name).toBe('Friends batch 1');
    expect(body.reason).toBeUndefined();
  });

  it("returns valid: false, reason: 'expired' for past expiresAt", async () => {
    const token = 'b'.repeat(22);
    testDb.insert(schema.inviteLinks).values({
      id: 'inv-2',
      token,
      name: 'Old link',
      createdBy: ADMIN_ID,
      createdAt: Date.now() - 10_000,
      maxUses: 10,
      usedCount: 0,
      expiresAt: Date.now() - 1_000,
      revokedAt: null,
    }).run();

    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/check-invite?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('expired');
    expect(body.name).toBeUndefined();
  });

  it("returns valid: false, reason: 'exhausted' for used-up invite", async () => {
    const token = 'c'.repeat(22);
    testDb.insert(schema.inviteLinks).values({
      id: 'inv-3',
      token,
      name: 'Burned',
      createdBy: ADMIN_ID,
      createdAt: Date.now(),
      maxUses: 1,
      usedCount: 1,
      expiresAt: null,
      revokedAt: null,
    }).run();

    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/check-invite?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('exhausted');
    expect(body.name).toBeUndefined();
  });

  it("returns valid: false, reason: 'invalid' for revoked invite (collapsed shield)", async () => {
    const token = 'd'.repeat(22);
    testDb.insert(schema.inviteLinks).values({
      id: 'inv-4',
      token,
      name: 'Revoked',
      createdBy: ADMIN_ID,
      createdAt: Date.now(),
      maxUses: 10,
      usedCount: 0,
      expiresAt: null,
      revokedAt: Date.now(),
    }).run();

    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/check-invite?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    // toEqual locks the byte-identical-response contract: the enumeration
    // shield depends on revoked/unknown/malformed all returning the SAME
    // body, not just bodies that happen to satisfy individual assertions.
    expect(res.json()).toEqual({ valid: false, reason: 'invalid' });
  });

  it("returns valid: false, reason: 'invalid' for unknown token", async () => {
    // 22-char base64url string that is not in the DB.
    const token = 'Z'.repeat(22);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/check-invite?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false, reason: 'invalid' });
  });

  it("returns valid: false, reason: 'invalid' for malformed token", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/check-invite?token=tooshort',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false, reason: 'invalid' });
  });

  it('returns byte-identical bodies across all invalid permutations', async () => {
    // The enumeration shield depends on revoked/unknown/malformed/missing
    // all returning the SAME body. Object equality (toEqual) catches any
    // future code path that adds an extra field on one branch but not others.
    const cases = [
      '/api/auth/check-invite',
      '/api/auth/check-invite?token=',
      '/api/auth/check-invite?token=tooshort',
      `/api/auth/check-invite?token=${'Z'.repeat(22)}`,
    ];
    for (const url of cases) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ valid: false, reason: 'invalid' });
    }
  });
});

describe('POST /api/auth/register — federation gate split', () => {
  beforeEach(() => {
    // Ensure a fresh instance_settings singleton row with both gates default-true.
    // The test harness's applyMigrations creates the table but does not seed the
    // id=1 row (production does so via migrate.ts:ensureDefaults on first boot).
    // Each test then mutates the toggles it cares about.
    testDb.delete(schema.instanceSettings).run();
    testDb.insert(schema.instanceSettings).values({
      id: 1,
      registrationOpen: 1,
      federatedRegistrationOpen: 1,
      updatedAt: Date.now(),
    }).run();
  });

  it('open registration: register without token succeeds; token field ignored if present', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);

    // Try with bogus token — still succeeds, token ignored
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', password: 'password123', inviteToken: 'fakefakefakefakefakeXX' },
    });
    expect(res2.statusCode).toBe(201);
  });

  it('closed registration without token: 403 "An invite is required"', async () => {
    testDb.update(schema.instanceSettings)
      .set({ registrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'newalice', password: 'password123' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('invite is required');
  });

  it('closed registration with valid token: succeeds, usedCount incremented, redemption written', async () => {
    testDb.update(schema.instanceSettings)
      .set({ registrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();
    const token = 'abcdefghijklmnopqrstuv';
    testDb.insert(schema.inviteLinks).values({
      id: 'inv-redeem-1',
      token,
      name: 'F',
      createdBy: ADMIN_ID,
      createdAt: Date.now(),
      maxUses: 5,
      usedCount: 0,
      expiresAt: null,
      revokedAt: null,
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'newalice', password: 'password123', inviteToken: token },
    });
    expect(res.statusCode).toBe(201);

    const inv = testDb.select().from(schema.inviteLinks)
      .where(eq(schema.inviteLinks.id, 'inv-redeem-1')).get();
    expect(inv?.usedCount).toBe(1);
    const redemptions = testDb.select().from(schema.inviteRedemptions)
      .where(eq(schema.inviteRedemptions.inviteId, 'inv-redeem-1')).all();
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]?.registrantUsername).toBe('newalice');
  });

  it('closed registration with invalid token: 403 "Invalid or expired invite"', async () => {
    testDb.update(schema.instanceSettings)
      .set({ registrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'newalice', password: 'password123', inviteToken: 'fakefakefakefakefakeXX' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('Invalid or expired');
  });

  it('open registration with token: usedCount NOT incremented', async () => {
    const token = 'abcdefghijklmnopqrstuv';
    testDb.insert(schema.inviteLinks).values({
      id: 'inv-ignore-1',
      token,
      name: 'F',
      createdBy: ADMIN_ID,
      createdAt: Date.now(),
      maxUses: 5,
      usedCount: 0,
      expiresAt: null,
      revokedAt: null,
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'newalice', password: 'password123', inviteToken: token },
    });
    expect(res.statusCode).toBe(201);

    const inv = testDb.select().from(schema.inviteLinks)
      .where(eq(schema.inviteLinks.id, 'inv-ignore-1')).get();
    expect(inv?.usedCount).toBe(0);

    const redemptions = testDb.select().from(schema.inviteRedemptions)
      .where(eq(schema.inviteRedemptions.inviteId, 'inv-ignore-1')).all();
    expect(redemptions).toHaveLength(0);
  });

  it('federated registration: blocked when federatedRegistrationOpen=false', async () => {
    testDb.update(schema.instanceSettings)
      .set({ federatedRegistrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'alice@otherhost',
        password: 'password123',
        homeInstance: 'otherhost',
        homeUserId: 'remote-id',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('Federated registration');
  });

  it('federated registration: blocked even with valid token when federatedRegistrationOpen=false', async () => {
    testDb.update(schema.instanceSettings)
      .set({ federatedRegistrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();
    const token = 'abcdefghijklmnopqrstuv';
    testDb.insert(schema.inviteLinks).values({
      id: 'inv-fed-blocked',
      token,
      name: 'F',
      createdBy: ADMIN_ID,
      createdAt: Date.now(),
      maxUses: 5,
      usedCount: 0,
      expiresAt: null,
      revokedAt: null,
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'alice@otherhost',
        password: 'password123',
        homeInstance: 'otherhost',
        homeUserId: 'remote-id',
        inviteToken: token,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('Federated registration');

    // Token MUST NOT be consumed
    const inv = testDb.select().from(schema.inviteLinks)
      .where(eq(schema.inviteLinks.id, 'inv-fed-blocked')).get();
    expect(inv?.usedCount).toBe(0);
  });

  it('federated registration: token IGNORED even if provided (no usedCount increment)', async () => {
    testDb.update(schema.instanceSettings)
      .set({ registrationOpen: 0, federatedRegistrationOpen: 1 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();
    const token = 'abcdefghijklmnopqrstuv';
    testDb.insert(schema.inviteLinks).values({
      id: 'inv-fed-ignore',
      token,
      name: 'F',
      createdBy: ADMIN_ID,
      createdAt: Date.now(),
      maxUses: 5,
      usedCount: 0,
      expiresAt: null,
      revokedAt: null,
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'alice@otherhost',
        password: 'password123',
        homeInstance: 'otherhost',
        homeUserId: 'remote-id',
        inviteToken: token,
      },
    });
    expect(res.statusCode).toBe(201);

    const inv = testDb.select().from(schema.inviteLinks)
      .where(eq(schema.inviteLinks.id, 'inv-fed-ignore')).get();
    expect(inv?.usedCount).toBe(0);

    const redemptions = testDb.select().from(schema.inviteRedemptions)
      .where(eq(schema.inviteRedemptions.inviteId, 'inv-fed-ignore')).all();
    expect(redemptions).toHaveLength(0);
  });

  it('closed registration: token last-slot race → 403 (in-txn re-derive)', async () => {
    testDb.update(schema.instanceSettings)
      .set({ registrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();
    const token = 'abcdefghijklmnopqrstuv';
    testDb.insert(schema.inviteLinks).values({
      id: 'inv-exhausted',
      token,
      name: 'F',
      createdBy: ADMIN_ID,
      createdAt: Date.now(),
      maxUses: 1,
      usedCount: 1, // already at the cap
      expiresAt: null,
      revokedAt: null,
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'newalice', password: 'password123', inviteToken: token },
    });
    expect(res.statusCode).toBe(403);
  });

  it('open registration: revoked/expired token is silently ignored, registration still succeeds', async () => {
    // Spec §5.7: when registration is open, the token field is not even
    // validated. A revoked token in the request body must NOT block signup
    // and must NOT be consumed.
    const adminId = ADMIN_ID;
    const token = 'r'.repeat(22);
    testDb.insert(schema.inviteLinks).values({
      id: 'inv-revoked',
      token,
      name: 'revoked',
      createdBy: adminId,
      createdAt: Date.now(),
      maxUses: 10,
      usedCount: 0,
      expiresAt: null,
      revokedAt: Date.now(), // revoked!
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'eve', password: 'password123', inviteToken: token },
    });
    expect(res.statusCode).toBe(201);

    // Revoked invite still revoked — usedCount unchanged, no redemption row.
    const inv = testDb.select().from(schema.inviteLinks).where(eq(schema.inviteLinks.id, 'inv-revoked')).get();
    expect(inv?.usedCount).toBe(0);
    expect(inv?.revokedAt).not.toBeNull();
    const reds = testDb.select().from(schema.inviteRedemptions).where(eq(schema.inviteRedemptions.inviteId, 'inv-revoked')).all();
    expect(reds).toHaveLength(0);
  });
});
