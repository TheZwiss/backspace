import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId, generateSnowflake } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'attacker';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

const sendToUser = vi.fn();
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: (...args: unknown[]) => sendToUser(...args),
    sendToDmMembers: vi.fn(),
    sendToRoom: vi.fn(),
    sendToAdmins: vi.fn(),
    getUserRoom: () => undefined,
    getRoom: () => undefined,
    getAllRooms: () => new Map(),
    getAllOnlineUserIds: () => [],
  },
}));

vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    isFederationRelayEnabled: () => false,
    queueDmCloseRelay: vi.fn(),
    queueDmRelay: vi.fn(),
    queueOutboxEvent: vi.fn(),
    queueReadStateRelay: vi.fn(),
    sendTypingRelay: vi.fn(),
    appendMutationLog: vi.fn(),
  };
});

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://local.test' };
});

// Embed resolution performs network work; the reply-target rules are unrelated to it.
vi.mock('../utils/embedResolver.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/embedResolver.js')>();
  return {
    ...actual,
    resolveEmbeds: vi.fn(async () => {}),
    reResolveEmbeds: vi.fn(async () => {}),
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

function seedUser(id: string, homeUserId: string | null = null, homeInstance: string | null = null): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    displayName: null,
    passwordHash: 'x',
    status: 'offline',
    isAdmin: 0,
    isDeleted: 0,
    discoverable: 1,
    homeInstance,
    homeUserId,
    createdAt: Date.now(),
  }).run();
}

function seedDmChannel(id: string, memberIds: string[]): void {
  testDb.insert(schema.dmChannels).values({
    id,
    ownerId: null,
    federatedId: null,
    createdAt: Date.now(),
    metadataUpdatedAt: 0,
  }).run();
  for (const userId of memberIds) {
    testDb.insert(schema.dmMembers).values({ dmChannelId: id, userId, closed: 0 }).run();
  }
}

function seedMessage(dmChannelId: string, userId: string, content: string, replyToId: string | null = null): string {
  const id = generateSnowflake();
  testDb.insert(schema.dmMessages).values({
    id,
    dmChannelId,
    userId,
    replyToId,
    content,
    type: 'user',
    createdAt: Date.now(),
  }).run();
  return id;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { dmRoutes } = await import('./dm.js');
  const { searchRoutes } = await import('./search.js');
  await app.register(dmRoutes);
  await app.register(searchRoutes);
  await app.ready();
  return app;
}

// DM-A: attacker + victim. DM-B: victim + outsider, attacker is NOT a member.
const DM_A = 'dm-a';
const DM_B = 'dm-b';

describe('DM reply targets are confined to their own channel', () => {
  let app: FastifyInstance;
  let secretMessageId: string;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);

    seedUser('attacker');
    // The victim is a federated identity so the guard is exercised on a
    // replicated row, not just a plain local one.
    seedUser('victim', 'remote-victim-1', 'https://remote.test');
    seedUser('outsider');

    seedDmChannel(DM_A, ['attacker', 'victim']);
    seedDmChannel(DM_B, ['victim', 'outsider']);

    secretMessageId = seedMessage(DM_B, 'victim', 'private thread content');

    currentUserId = 'attacker';
    sendToUser.mockClear();
    app = await buildApp();
  });

  describe('REST create — POST /api/dm/:id/messages', () => {
    it('rejects a reply target that lives in another DM channel and persists nothing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/dm/${DM_A}/messages`,
        payload: { content: 'hi', replyToId: secretMessageId },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Invalid reply target');

      const inA = testDb.select().from(schema.dmMessages)
        .where(eq(schema.dmMessages.dmChannelId, DM_A)).all();
      expect(inA).toHaveLength(0);
    });

    it('rejects a reply target that does not exist at all', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/dm/${DM_A}/messages`,
        payload: { content: 'hi', replyToId: 'does-not-exist' },
      });

      expect(res.statusCode).toBe(400);
      const inA = testDb.select().from(schema.dmMessages)
        .where(eq(schema.dmMessages.dmChannelId, DM_A)).all();
      expect(inA).toHaveLength(0);
    });

    it('accepts a reply target in the same channel and hydrates it', async () => {
      const targetId = seedMessage(DM_A, 'victim', 'in-channel target');

      const res = await app.inject({
        method: 'POST',
        url: `/api/dm/${DM_A}/messages`,
        payload: { content: 'hi', replyToId: targetId },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.replyToId).toBe(targetId);
      expect(body.replyTo?.id).toBe(targetId);
      expect(body.replyTo?.content).toBe('in-channel target');
    });
  });

  describe('WS create — dm_message_create', () => {
    it('rejects a reply target that lives in another DM channel and persists nothing', async () => {
      const { handleClientEvent } = await import('../ws/events.js');

      handleClientEvent(
        { type: 'dm_message_create', dmChannelId: DM_A, content: 'hi', replyToId: secretMessageId },
        'attacker',
        'attacker',
        {} as never,
        false,
      );

      const inA = testDb.select().from(schema.dmMessages)
        .where(eq(schema.dmMessages.dmChannelId, DM_A)).all();
      expect(inA).toHaveLength(0);

      expect(sendToUser).toHaveBeenCalledWith('attacker', {
        type: 'error',
        message: 'Invalid reply target',
      });
    });

    it('accepts a reply target in the same channel', async () => {
      const { handleClientEvent } = await import('../ws/events.js');
      const targetId = seedMessage(DM_A, 'victim', 'in-channel target');

      handleClientEvent(
        { type: 'dm_message_create', dmChannelId: DM_A, content: 'hi', replyToId: targetId },
        'attacker',
        'attacker',
        {} as never,
        false,
      );

      const inA = testDb.select().from(schema.dmMessages)
        .where(eq(schema.dmMessages.dmChannelId, DM_A)).all();
      // The seeded target plus the newly created reply.
      expect(inA).toHaveLength(2);
      const created = inA.find(m => m.id !== targetId);
      expect(created?.replyToId).toBe(targetId);
    });
  });

  describe('hydration of pre-existing cross-channel rows', () => {
    // Simulates a row written before the create-time guard existed.
    let poisonedId: string;

    beforeEach(() => {
      poisonedId = seedMessage(DM_A, 'attacker', 'look at this', secretMessageId);
    });

    it('does not hydrate the foreign message in getDmMessageWithUser', async () => {
      const { getDmMessageWithUser } = await import('./dm.js');
      const hydrated = getDmMessageWithUser(poisonedId);
      expect(hydrated).not.toBeNull();
      expect(hydrated!.replyTo).toBeNull();
    });

    it('does not hydrate the foreign message in GET /api/dm/:id/messages', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/dm/${DM_A}/messages` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<{ id: string; replyTo: unknown }>;
      const row = body.find(m => m.id === poisonedId);
      expect(row).toBeDefined();
      expect(row!.replyTo).toBeNull();
    });

    it('does not hydrate the foreign message in GET /api/dm/:id/search', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/dm/${DM_A}/search?q=look` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { results: Array<{ id: string; replyTo: unknown }> };
      const row = body.results.find(m => m.id === poisonedId);
      expect(row).toBeDefined();
      expect(row!.replyTo).toBeNull();
    });

    it('does not hydrate the foreign message in GET /api/dm/:id/messages/around', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/dm/${DM_A}/messages/around?messageId=${poisonedId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { messages: Array<{ id: string; replyTo: unknown }> } | Array<{ id: string; replyTo: unknown }>;
      const list = Array.isArray(body) ? body : body.messages;
      const row = list.find(m => m.id === poisonedId);
      expect(row).toBeDefined();
      expect(row!.replyTo).toBeNull();
    });
  });
});
