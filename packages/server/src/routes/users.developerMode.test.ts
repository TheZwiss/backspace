import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signJwt, hashPassword } from '../utils/auth.js';

setWorkerId(26);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sendToUser = vi.hoisted(() => vi.fn());

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: sendToUser,
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

const LOCAL_ID = 'local-1';
const LOCAL_USERNAME = 'alice';
const LOCAL_PASSWORD = 'correct-horse-battery';

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${signJwt({ userId: LOCAL_ID, username: LOCAL_USERNAME })}` };
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.users).values({
    id: LOCAL_ID,
    username: LOCAL_USERNAME,
    passwordHash: await hashPassword(LOCAL_PASSWORD),
    isAdmin: 0,
    isDeleted: 0,
    createdAt: Date.now(),
  }).run();
  app = await buildApp();
});


/**
 * Developer Mode is stored with the account, so every device of the account
 * sees the same switch. It is private: the account's own view carries it, no
 * one else's view does, and only the account's own sockets hear of a change.
 */
describe('PATCH /api/users/@me developerMode', () => {
  beforeEach(() => { sendToUser.mockClear(); });

  it('is off for a new account', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users/@me', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().developerMode).toBe(false);
  });

  it('turns on, persists, and reads back on the next request', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/users/@me', headers: auth(), payload: { developerMode: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().developerMode).toBe(true);
    expect(testDb.select().from(schema.users).get()?.developerMode).toBe(1);

    const again = await app.inject({ method: 'GET', url: '/api/users/@me', headers: auth() });
    expect(again.json().developerMode).toBe(true);

    const off = await app.inject({ method: 'PATCH', url: '/api/users/@me', headers: auth(), payload: { developerMode: false } });
    expect(off.json().developerMode).toBe(false);
    expect(testDb.select().from(schema.users).get()?.developerMode).toBe(0);
  });

  it('rejects a value that is not a boolean and names the field', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/users/@me', headers: auth(), payload: { developerMode: 'yes' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed', details: { field: 'developerMode' } });
    expect(testDb.select().from(schema.users).get()?.developerMode).toBe(0);
  });

  it("tells only the account's own sockets, with the new value", async () => {
    await app.inject({ method: 'PATCH', url: '/api/users/@me', headers: auth(), payload: { developerMode: true } });
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(sendToUser).toHaveBeenCalledWith(LOCAL_ID, expect.objectContaining({
      type: 'user_updated',
      user: expect.objectContaining({ id: LOCAL_ID, developerMode: true }),
    }));
  });

  it("is absent from another account's view of the user", async () => {
    await app.inject({ method: 'PATCH', url: '/api/users/@me', headers: auth(), payload: { developerMode: true } });
    const { sanitizeUser } = await import('../utils/sanitize.js');
    const row = testDb.select().from(schema.users).get()!;
    expect('developerMode' in sanitizeUser(row, false)).toBe(false);
    expect(sanitizeUser(row, true).developerMode).toBe(true);
  });
});
