import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { oneOnOneKey } from '../utils/dmConversation.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'user-A';
let relayEnabled = true;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
  },
}));

vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    isFederationRelayEnabled: () => relayEnabled,
    queueDmCloseRelay: vi.fn(),
    sendTypingRelay: vi.fn(),
    queueDmRelay: vi.fn(),
    queueOutboxEvent: vi.fn(),
    appendMutationLog: vi.fn(),
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

function seedTwoUsers(): void {
  testDb.insert(schema.users).values({
    id: 'user-A',
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'x',
    homeUserId: 'user-A',
    homeInstance: 'https://local.example',
    createdAt: Date.now(),
  }).run();

  testDb.insert(schema.users).values({
    id: 'user-B',
    username: 'bob',
    displayName: 'Bob',
    passwordHash: 'x',
    homeUserId: 'remote-bob',
    homeInstance: 'https://remote.example',
    createdAt: Date.now(),
  }).run();

  testDb.insert(schema.users).values({
    id: 'user-C',
    username: 'carol',
    displayName: 'Carol',
    passwordHash: 'x',
    homeUserId: null,
    homeInstance: null,
    createdAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { dmRoutes } = await import('./dm.js');
  await app.register(dmRoutes);
  await app.ready();
  return app;
}

describe('POST /api/dm — idempotent existing DM response includes federatedId', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedTwoUsers();
    currentUserId = 'user-A';
    relayEnabled = true;
    app = await buildApp();
  });

  it('fresh-create returns a federatedId for federated 1-on-1 DM', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/dm',
      payload: { userId: 'user-B' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; federatedId: string | null };
    expect(body.federatedId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('idempotent existing-DM path returns the same federatedId field', async () => {
    // First call creates the DM
    const first = await app.inject({
      method: 'POST',
      url: '/api/dm',
      payload: { userId: 'user-B' },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { id: string; federatedId: string | null };
    const expectedFederatedId = firstBody.federatedId;
    expect(expectedFederatedId).toMatch(/^[a-f0-9]{32}$/);

    // Second call returns the existing DM idempotently — must carry federatedId
    const second = await app.inject({
      method: 'POST',
      url: '/api/dm',
      payload: { userId: 'user-B' },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { id: string; federatedId: string | null };

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.federatedId).toBe(expectedFederatedId);
  });
});

describe('every 1-on-1 is keyed at insert', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedTwoUsers();
    currentUserId = 'user-A';
    relayEnabled = true;
    app = await buildApp();
  });

  function storedKey(channelId: string): string | null {
    return testDb.select().from(schema.dmChannels).all().find(c => c.id === channelId)!.federatedId;
  }

  it('POST /api/dm keys a federated pair while relay is off', async () => {
    relayEnabled = false;
    const res = await app.inject({ method: 'POST', url: '/api/dm', payload: { userId: 'user-B' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; federatedId: string | null };
    const expected = oneOnOneKey({ id: 'user-A', homeUserId: 'user-A' }, { id: 'user-B', homeUserId: 'remote-bob' });
    expect(body.federatedId).toBe(expected);
    expect(storedKey(body.id)).toBe(expected);
  });

  it('POST /api/dm keys a pair of two users of this instance', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dm', payload: { userId: 'user-C' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; federatedId: string | null };
    const expected = oneOnOneKey({ id: 'user-A', homeUserId: 'user-A' }, { id: 'user-C', homeUserId: null });
    expect(body.federatedId).toBe(expected);
    expect(storedKey(body.id)).toBe(expected);
  });

  it('ensureOneOnOneDmChannel keys what it inserts, relay on or off', async () => {
    const { ensureOneOnOneDmChannel } = await import('./dm.js');
    relayEnabled = false;
    const carol = testDb.select().from(schema.users).all().find(u => u.id === 'user-C')!;
    const bob = testDb.select().from(schema.users).all().find(u => u.id === 'user-B')!;
    const withCarol = ensureOneOnOneDmChannel('user-A', carol, testDb as never);
    const withBob = ensureOneOnOneDmChannel('user-A', bob, testDb as never);
    expect(storedKey(withCarol)).toBe(oneOnOneKey({ id: 'user-A', homeUserId: 'user-A' }, carol));
    expect(storedKey(withBob)).toBe(oneOnOneKey({ id: 'user-A', homeUserId: 'user-A' }, bob));
  });
});

describe('POST /api/dm finds a 1-on-1 by its key first', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedTwoUsers();
    currentUserId = 'user-A';
    relayEnabled = true;
    app = await buildApp();
  });

  it('answers 200 with the relay-created row when it holds the key under another member row for the same person', async () => {
    // An older row for bob's identity: the relay created the conversation with it.
    testDb.insert(schema.users).values({
      id: 'user-B-old', username: 'bob-old', passwordHash: 'x',
      homeUserId: 'remote-bob', homeInstance: 'https://remote.example', createdAt: Date.now(),
    }).run();
    const key = oneOnOneKey({ id: 'user-A', homeUserId: null }, { id: 'user-B', homeUserId: 'remote-bob' });
    testDb.insert(schema.dmChannels).values({ id: 'relayed', federatedId: key, createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'relayed', userId: 'user-A', closed: 0 },
      { dmChannelId: 'relayed', userId: 'user-B-old', closed: 0 },
    ]).run();

    const res = await app.inject({ method: 'POST', url: '/api/dm', payload: { userId: 'user-B' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string }).id).toBe('relayed');
    const members = testDb.select().from(schema.dmMembers).all().filter(m => m.dmChannelId === 'relayed').map(m => m.userId).sort();
    expect(members).toEqual(['user-A', 'user-B']);
    expect(testDb.select().from(schema.dmChannels).all()).toHaveLength(1);
  });
});
