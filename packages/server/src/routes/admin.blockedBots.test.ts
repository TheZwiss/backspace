import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signJwt } from '../utils/auth.js';

/**
 * A bot of another instance the admin deleted with `blockBot`: its next
 * registration with a valid bot proof is refused (bots.md, section 7,
 * "Blocking a bot of another instance").
 */

setWorkerId(31);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    forceDisconnectUser: vi.fn(),
    removeUserSpace: vi.fn(),
  },
}));
// The home's signed answer to a bot proof: the bot with id `home-bot` on a.example.
vi.mock('../utils/federationAttach.js', () => ({
  verifyAttachProofWithPeer: vi.fn(async () => ({ valid: true, isBot: true, username: 'radio_bot', homeUserId: 'home-bot' })),
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

const admin = () => ({ Authorization: `Bearer ${signJwt({ userId: 'admin', username: 'admin' })}` });

const register = () => app.inject({
  method: 'POST',
  url: '/api/auth/register',
  payload: {
    username: 'radio_bot@a.example',
    password: 'x'.repeat(32),
    homeInstance: 'A.example',
    homeUserId: 'ignored',
    botProof: 'b'.repeat(64),
  },
});

const blockedRows = () => sqlite.prepare('SELECT home_instance, home_user_id, username, blocked_by FROM blocked_bots').all();

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  // Migrations do not seed the id=1 row (production does on first boot); register reads it.
  testDb.insert(schema.instanceSettings).values({ id: 1, registrationOpen: 1, federatedRegistrationOpen: 1, updatedAt: 1 }).run();
  testDb.insert(schema.users).values([
    { id: 'admin', username: 'admin', passwordHash: 'x', isAdmin: 1, createdAt: 1 },
    { id: 'local-bot', username: 'local_bot', passwordHash: '!bot', isBot: 1, botOwnerId: 'admin', createdAt: 1 },
    { id: 'person', username: 'pal@a.example', passwordHash: 'x', homeInstance: 'a.example', homeUserId: 'home-pal', createdAt: 1 },
  ]).run();
  testDb.insert(schema.federationPeers).values({
    id: 'peer-a',
    origin: 'https://a.example',
    hmacSecret: 's'.repeat(64),
    status: 'active',
    consecutiveFailures: 0,
    consecutiveAuthFailures: 0,
    lastSyncedAt: 0,
    nonceSupported: 1,
    autoRotateIntervalDays: 90,
    createdAt: 1,
  }).run();
  const { adminRoutes } = await import('./admin.js');
  const { authRoutes } = await import('./auth.js');
  app = Fastify({ logger: false });
  await app.register(adminRoutes);
  await app.register(authRoutes);
  await app.ready();
});

describe('blocking a bot of another instance', () => {
  it('a deleted and blocked bot cannot register again until it is unblocked', async () => {
    const first = await register();
    expect(first.statusCode).toBe(201);
    const botId = (first.json() as { user: { id: string } }).user.id;

    const del = await app.inject({ method: 'DELETE', url: `/api/admin/users/${botId}?blockBot=1`, headers: admin() });
    expect(del.statusCode).toBe(200);
    expect(blockedRows()).toEqual([
      { home_instance: 'a.example', home_user_id: 'home-bot', username: 'radio_bot@a.example', blocked_by: 'admin' },
    ]);

    const again = await register();
    expect(again.statusCode).toBe(403);
    expect((again.json() as { code: string }).code).toBe('bot_blocked');

    const list = await app.inject({ method: 'GET', url: '/api/admin/blocked-bots', headers: admin() });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { bots: Array<{ username: string }> }).bots.map(b => b.username)).toEqual(['radio_bot@a.example']);

    const unblock = await app.inject({ method: 'DELETE', url: '/api/admin/blocked-bots/a.example/home-bot', headers: admin() });
    expect(unblock.statusCode).toBe(200);
    expect(blockedRows()).toEqual([]);
    expect((await register()).statusCode).toBe(201);
  });

  it('a delete without blockBot lets the bot register again', async () => {
    const botId = (((await register()).json()) as { user: { id: string } }).user.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/users/${botId}`, headers: admin() })).statusCode).toBe(200);
    expect(blockedRows()).toEqual([]);
    expect((await register()).statusCode).toBe(201);
  });

  it('refuses blockBot for a local bot and for a person, and deletes neither', async () => {
    for (const id of ['local-bot', 'person']) {
      const res = await app.inject({ method: 'DELETE', url: `/api/admin/users/${id}?blockBot=1`, headers: admin() });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { code: string }).code).toBe('bot_block_not_federated');
      expect(sqlite.prepare('SELECT is_deleted AS d FROM users WHERE id = ?').get(id)).toEqual({ d: 0 });
    }
    expect(blockedRows()).toEqual([]);
  });

  it('unblocking a pair that is not blocked answers 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/blocked-bots/a.example/nobody', headers: admin() });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('blocked_bot_not_found');
  });

  it('the list and unblock are for admins only', async () => {
    const person = { Authorization: `Bearer ${signJwt({ userId: 'person', username: 'pal@a.example' })}` };
    expect((await app.inject({ method: 'GET', url: '/api/admin/blocked-bots', headers: person })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/blocked-bots/a.example/home-bot', headers: person })).statusCode).toBe(403);
  });
});
