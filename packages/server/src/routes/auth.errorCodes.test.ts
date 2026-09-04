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
import { hashPassword } from '../utils/auth.js';

setWorkerId(24);
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
  const { authRoutes } = await import('./auth.js');
  const f = Fastify({ logger: false });
  await f.register(authRoutes);
  await f.ready();
  return f;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  // Migrations create instance_settings but do not seed the id=1 row
  // (production does that on first boot); the registration gates read it.
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    registrationOpen: 1,
    federatedRegistrationOpen: 1,
    updatedAt: Date.now(),
  }).run();
  testDb.insert(schema.users).values({
    id: 'gone-1',
    username: 'gone',
    passwordHash: await hashPassword('password123'),
    isAdmin: 0,
    isDeleted: 1,
    createdAt: Date.now(),
  }).run();
  app = await buildApp();
});

// Every user-visible rejection carries a stable code next to the English text
// so the client can say it in the user's language. These tests pin the codes
// (and their details) for the sites the register page and login page show.
describe('auth routes send error codes', () => {
  it('register: a username outside 3-32 characters is username_length_invalid with the limits', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'ab', password: 'password123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'username_length_invalid',
      details: { min: 3, max: 32 },
      statusCode: 400,
    });
  });

  it('register: a username with other characters is username_characters_invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'Al ice', password: 'password123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('username_characters_invalid');
  });

  it('register: a short password is password_too_short with the minimum', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'password_too_short', details: { min: 8 } });
  });

  it('register: closed registration without a token is invite_required', async () => {
    testDb.update(schema.instanceSettings)
      .set({ registrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'password123' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('invite_required');
  });

  it('register: a taken username is username_taken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'gone', password: 'password123' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('username_taken');
  });

  it('register: a federated registration without the @domain form is replicated_username_format_required', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'password123', homeInstance: 'orbit.test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('replicated_username_format_required');
  });

  it('login: a deleted account is account_deleted, not invalid_credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'gone', password: 'password123' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('account_deleted');
  });

  it('login: an unknown user is invalid_credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'password123' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('invalid_credentials');
  });

  it('check-username: keeps the reason text and adds the matching code', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/check-username?username=ab' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      available: false,
      reason: 'Username must be between 3 and 32 characters',
      code: 'username_length_invalid',
      details: { min: 3, max: 32 },
    });
  });

  it('check-username: closed registration is registration_closed', async () => {
    testDb.update(schema.instanceSettings)
      .set({ registrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();
    const res = await app.inject({ method: 'GET', url: '/api/auth/check-username?username=alice' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ available: false, code: 'registration_closed' });
  });
});
