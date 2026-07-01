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

setWorkerId(12);
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
  const { federationRoutes } = await import('./federation.js');
  const f = Fastify();
  await f.register(federationRoutes);
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

  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

function adminToken(): string {
  return signJwt({ userId: ADMIN_ID, username: ADMIN_USERNAME });
}

function userToken(): string {
  return signJwt({ userId: USER_ID, username: USER_USERNAME });
}

describe('GET /api/federation/reset-events', () => {
  it('returns reset events with their orphaned real accounts and space info', async () => {
    testDb.insert(schema.federationResetEvents).values({
      origin: 'orbit.ddns.net',
      deadEpoch: 'E0',
      newEpoch: 'E1',
      detectedAt: 1000,
      resolvedAt: 2000,
      stubCount: 3,
      orphanedAccountCount: 1,
    }).run();

    const uid = 'dave-1';
    testDb.insert(schema.users).values({
      id: uid,
      username: 'dave@orbit.ddns.net',
      displayName: 'Dave',
      avatarColor: '#abc',
      passwordHash: 'real-hash',
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'h',
      federationHomeOrphaned: 1,
      isDeleted: 0,
      createdAt: 1,
    }).run();

    // Space owned by the orphaned account.
    testDb.insert(schema.spaces).values({
      id: 's1',
      name: 'Dave HQ',
      ownerId: uid,
      createdAt: 1,
    }).run();

    // Membership rows (member of 2 spaces: his own + a second).
    testDb.insert(schema.spaces).values({
      id: 's2',
      name: 'Other Space',
      ownerId: ADMIN_ID,
      createdAt: 1,
    }).run();
    testDb.insert(schema.spaceMembers).values([
      { spaceId: 's1', userId: uid, joinedAt: 1 },
      { spaceId: 's2', userId: uid, joinedAt: 1 },
    ]).run();

    // Two channels + messages authored by the orphaned account.
    testDb.insert(schema.channels).values({
      id: 'c1', spaceId: 's1', name: 'general', type: 'text', createdAt: 1,
    }).run();
    testDb.insert(schema.messages).values([
      { id: 'm1', channelId: 'c1', userId: uid, content: 'hi', createdAt: 1 },
      { id: 'm2', channelId: 'c1', userId: uid, content: 'yo', createdAt: 2 },
    ]).run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/federation/reset-events',
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(1);
    const ev = body.events[0];
    expect(ev.origin).toBe('orbit.ddns.net');
    expect(ev.deadEpoch).toBe('E0');
    expect(ev.newEpoch).toBe('E1');
    expect(ev.detectedAt).toBe(1000);
    expect(ev.resolvedAt).toBe(2000);
    expect(ev.stubCount).toBe(3);
    expect(ev.orphanedAccountCount).toBe(1);
    expect(ev.orphanedAccounts).toHaveLength(1);
    const acct = ev.orphanedAccounts[0];
    expect(acct.username).toBe('dave@orbit.ddns.net');
    expect(acct.displayName).toBe('Dave');
    expect(acct.avatarColor).toBe('#abc');
    expect(acct.ownedSpaces).toEqual([{ id: 's1', name: 'Dave HQ' }]);
    expect(acct.spaceMemberCount).toBe(2);
    expect(acct.messageCount).toBe(2);
  });

  it('requires admin (401/403 for non-admin)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/federation/reset-events',
      headers: { authorization: `Bearer ${userToken()}` },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});
