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

setWorkerId(27);
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
 * While a revoke of a bot is still waiting for an instance (it was away), the
 * old federated account is still there: the home issues no new credential for
 * that instance, and the owner is told why.
 */
describe('POST /api/users/@me/federation-credential for a bot with a pending revoke', () => {
  const BOT_ID = 'bot-1';
  const botAuth = () => ({ Authorization: `Bearer ${signJwt({ userId: BOT_ID, username: 'radio_bot' })}` });

  beforeEach(() => {
    testDb.insert(schema.users).values({
      id: BOT_ID, username: 'radio_bot', passwordHash: '!bot', isBot: 1, botOwnerId: LOCAL_ID, createdAt: Date.now(),
    }).run();
  });

  const credential = (headers: Record<string, string>, origin: string) =>
    app.inject({ method: 'POST', url: '/api/users/@me/federation-credential', headers, payload: { origin } });

  it('is refused for the instance that still has the old account, with a code', async () => {
    testDb.insert(schema.botRevocations).values({
      botId: BOT_ID, origin: 'https://host.test', mode: 'soft', attempts: 1, createdAt: Date.now(), nextAttemptAt: Date.now() + 1,
    }).run();
    const res = await credential(botAuth(), 'https://host.test');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('bot_revocation_pending');
    expect(testDb.select().from(schema.userFederationCredentials).all()).toHaveLength(0);
  });

  it('is still issued for another instance', async () => {
    testDb.insert(schema.botRevocations).values({
      botId: BOT_ID, origin: 'https://host.test', mode: 'soft', attempts: 1, createdAt: Date.now(), nextAttemptAt: Date.now() + 1,
    }).run();
    const res = await credential(botAuth(), 'https://other.test');
    expect(res.statusCode).toBe(200);
  });

  it('does not touch a person', async () => {
    testDb.insert(schema.botRevocations).values({
      botId: BOT_ID, origin: 'https://host.test', mode: 'soft', attempts: 1, createdAt: Date.now(), nextAttemptAt: Date.now() + 1,
    }).run();
    const res = await credential(auth(), 'https://host.test');
    expect(res.statusCode).toBe(200);
  });
});
