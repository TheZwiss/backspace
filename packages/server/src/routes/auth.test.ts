import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
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
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('invalid');
    expect(body.name).toBeUndefined();
  });

  it("returns valid: false, reason: 'invalid' for unknown token", async () => {
    // 22-char base64url string that is not in the DB.
    const token = 'Z'.repeat(22);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/check-invite?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('invalid');
    expect(body.name).toBeUndefined();
  });

  it("returns valid: false, reason: 'invalid' for malformed token", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/check-invite?token=tooshort',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('invalid');
    expect(body.name).toBeUndefined();
  });

  it('does not include name field on invalid responses', async () => {
    // Sweep across all invalid permutations to assert the absence-of-leak
    // contract once for the whole endpoint, not just per-status.
    const cases = [
      { url: '/api/auth/check-invite' },
      { url: '/api/auth/check-invite?token=' },
      { url: '/api/auth/check-invite?token=tooshort' },
      { url: `/api/auth/check-invite?token=${'Z'.repeat(22)}` },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: 'GET', url: c.url });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(false);
      expect(body).not.toHaveProperty('name');
    }
  });
});
