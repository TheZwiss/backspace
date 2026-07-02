import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signJwt } from '../utils/auth.js';

setWorkerId(13);
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

// authRoutes → ./federation.js → ../ws/handler.js; stub the connection manager.
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    evictFederatedCallsForHost: vi.fn(),
    federatedCalls: new Map(),
    isUserOnline: vi.fn(),
    lateBindFederatedCall: vi.fn(),
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
  const { authRoutes } = await import('./auth.js');
  const f = Fastify();
  await f.register(authRoutes);
  return f;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.users).values([
    { id: 'native-1', username: 'youruser', passwordHash: 'x', homeInstance: null, createdAt: 1 },
    { id: 'fed-1', username: 'guest@orbit.test', passwordHash: 'x', homeInstance: 'orbit.test', homeUserId: 'g-home', createdAt: 1 },
  ]).run();
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/auth/attach-proof', () => {
  it('mints a one-time token bound to the target domain', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/attach-proof',
      headers: { authorization: `Bearer ${signJwt({ userId: 'native-1', username: 'youruser' })}` },
      payload: { targetDomain: 'nova.ddns.net' },
    });
    expect(res.statusCode).toBe(200);
    const { token } = JSON.parse(res.body);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const row = testDb.select().from(schema.federationAttachProofs).all()[0]!;
    expect(row.homeUserId).toBe('native-1');
    expect(row.targetDomain).toBe('nova.ddns.net');
    expect(row.usedAt).toBeNull();
    expect(row.expiresAt - row.createdAt).toBe(60_000);
  });

  it('rejects non-native (federated) accounts', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/attach-proof',
      headers: { authorization: `Bearer ${signJwt({ userId: 'fed-1', username: 'guest@orbit.test' })}` },
      payload: { targetDomain: 'nova.ddns.net' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a missing/invalid targetDomain', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/attach-proof',
      headers: { authorization: `Bearer ${signJwt({ userId: 'native-1', username: 'youruser' })}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/attach-proof', payload: { targetDomain: 'nova.ddns.net' } });
    expect(res.statusCode).toBe(401);
  });

  it('deletes expired rows opportunistically on mint', async () => {
    testDb.insert(schema.federationAttachProofs).values({
      token: 'e'.repeat(64), homeUserId: 'native-1', targetDomain: 'x.test',
      createdAt: 1, expiresAt: 2, usedAt: null,
    }).run();
    await app.inject({
      method: 'POST',
      url: '/api/auth/attach-proof',
      headers: { authorization: `Bearer ${signJwt({ userId: 'native-1', username: 'youruser' })}` },
      payload: { targetDomain: 'nova.ddns.net' },
    });
    const tokens = testDb.select().from(schema.federationAttachProofs).all().map(r => r.token);
    expect(tokens).not.toContain('e'.repeat(64));
    expect(tokens).toHaveLength(1);
  });
});
