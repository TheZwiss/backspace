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
import {
  PermissionBits,
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsToString,
} from '@backspace/shared/src/permissions.js';

setWorkerId(2);

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
const sendToChannel = vi.fn();
const sendToSpace = vi.fn();
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: (...args: unknown[]) => sendToUser(...args),
    sendToChannel: (...args: unknown[]) => sendToChannel(...args),
    sendToSpace: (...args: unknown[]) => sendToSpace(...args),
    sendToDmMembers: vi.fn(),
    sendToRoom: vi.fn(),
    sendToAdmins: vi.fn(),
    getUserRoom: () => undefined,
    getRoom: () => undefined,
    getAllRooms: () => new Map(),
    getAllOnlineUserIds: () => [],
  },
}));

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

const NOW = 1_700_000_000_000;

const SPACE = 'space-1';
const OTHER_SPACE = 'space-2';
const GENERAL = 'chan-general';
const LOUNGE = 'chan-lounge';
const SECRET = 'chan-secret';
const OTHER_SPACE_CHANNEL = 'chan-other-space';

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
    createdAt: NOW,
  }).run();
}

function seedSpace(spaceId: string, ownerId: string, memberIds: string[]): void {
  testDb.insert(schema.spaces).values({
    id: spaceId,
    name: spaceId,
    ownerId,
    inviteCode: `invite-${spaceId}`,
    visibility: 'private',
    createdAt: NOW,
  }).run();
  // @everyone role carries the default member permissions.
  testDb.insert(schema.roles).values({
    id: spaceId,
    spaceId,
    name: '@everyone',
    permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
    createdAt: NOW,
  }).run();
  for (const userId of memberIds) {
    testDb.insert(schema.spaceMembers).values({ spaceId, userId, joinedAt: NOW }).run();
  }
}

function seedChannel(channelId: string, spaceId: string): void {
  testDb.insert(schema.channels).values({
    id: channelId,
    spaceId,
    name: channelId,
    type: 'text',
    position: 0,
    categoryId: null,
    createdAt: NOW,
  }).run();
}

/** Deny the @everyone role read access to one channel. */
function denyEveryoneRead(channelId: string, spaceId: string): void {
  testDb.insert(schema.channelOverrides).values({
    channelId,
    targetType: 'role',
    targetId: spaceId,
    allow: '0',
    deny: permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY),
  }).run();
}

function seedMessage(channelId: string, userId: string, content: string, replyToId: string | null = null): string {
  const id = generateSnowflake();
  testDb.insert(schema.messages).values({
    id,
    channelId,
    userId,
    replyToId,
    content,
    createdAt: Date.now(),
  }).run();
  return id;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { messageRoutes } = await import('./messages.js');
  const { searchRoutes } = await import('./search.js');
  await app.register(messageRoutes);
  await app.register(searchRoutes);
  await app.ready();
  return app;
}

describe('space-channel reply targets are confined to their own channel', () => {
  let app: FastifyInstance;
  /** Message in a channel the attacker may NOT read. */
  let secretMessageId: string;
  /** Message in a sibling channel the attacker MAY read. */
  let loungeMessageId: string;
  /** Message in a space the attacker has not joined. */
  let otherSpaceMessageId: string;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    testDb = drizzle(sqlite, { schema });

    seedUser('owner');
    seedUser('attacker');
    // The victim is a federated identity so the rule is exercised against a
    // replicated user row, not only a plain local one.
    seedUser('victim', 'remote-victim-1', 'https://remote.test');
    seedUser('stranger');

    seedSpace(SPACE, 'owner', ['attacker', 'victim']);
    seedChannel(GENERAL, SPACE);
    seedChannel(LOUNGE, SPACE);
    seedChannel(SECRET, SPACE);
    denyEveryoneRead(SECRET, SPACE);

    seedSpace(OTHER_SPACE, 'stranger', ['stranger']);
    seedChannel(OTHER_SPACE_CHANNEL, OTHER_SPACE);

    secretMessageId = seedMessage(SECRET, 'victim', 'restricted channel content');
    loungeMessageId = seedMessage(LOUNGE, 'victim', 'sibling channel content');
    otherSpaceMessageId = seedMessage(OTHER_SPACE_CHANNEL, 'stranger', 'other space content');

    currentUserId = 'attacker';
    sendToUser.mockClear();
    sendToChannel.mockClear();
    sendToSpace.mockClear();
    app = await buildApp();
  });

  describe('fixture controls', () => {
    it('the attacker can read the destination channel', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/channels/${GENERAL}/messages` });
      expect(res.statusCode).toBe(200);
    });

    it('the attacker can read the sibling channel', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/channels/${LOUNGE}/messages` });
      expect(res.statusCode).toBe(200);
    });

    it('the attacker cannot read the restricted channel', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/channels/${SECRET}/messages` });
      expect(res.statusCode).toBe(403);
    });

    it('the attacker cannot read the other space', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/channels/${OTHER_SPACE_CHANNEL}/messages` });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('REST create: POST /api/channels/:id/messages', () => {
    function rowsIn(channelId: string): (typeof schema.messages.$inferSelect)[] {
      return testDb.select().from(schema.messages).where(eq(schema.messages.channelId, channelId)).all();
    }

    it('accepts a reply target in the same channel and hydrates it', async () => {
      // Positive control: proves the harness observes both the insert and the
      // hydrated reply preview when the rule is satisfied.
      const targetId = seedMessage(GENERAL, 'victim', 'in-channel target');

      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${GENERAL}/messages`,
        payload: { content: 'hi', replyToId: targetId },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.replyToId).toBe(targetId);
      expect(body.replyTo?.id).toBe(targetId);
      expect(body.replyTo?.content).toBe('in-channel target');
      expect(rowsIn(GENERAL)).toHaveLength(2);
    });

    it('rejects a reply target in a channel the caller cannot read', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${GENERAL}/messages`,
        payload: { content: 'hi', replyToId: secretMessageId },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Invalid reply target');
      expect(rowsIn(GENERAL)).toHaveLength(0);
    });

    it('rejects a reply target in a sibling channel the caller can read', async () => {
      // The destination channel's audience is not the sibling channel's
      // audience, so a readable cross-channel target is refused too.
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${GENERAL}/messages`,
        payload: { content: 'hi', replyToId: loungeMessageId },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Invalid reply target');
      expect(rowsIn(GENERAL)).toHaveLength(0);
    });

    it('rejects a reply target in another space', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${GENERAL}/messages`,
        payload: { content: 'hi', replyToId: otherSpaceMessageId },
      });

      expect(res.statusCode).toBe(400);
      expect(rowsIn(GENERAL)).toHaveLength(0);
    });

    it('rejects a reply target that does not exist at all', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${GENERAL}/messages`,
        payload: { content: 'hi', replyToId: 'does-not-exist' },
      });

      expect(res.statusCode).toBe(400);
      expect(rowsIn(GENERAL)).toHaveLength(0);
    });
  });

  describe('WS create: message_create', () => {
    function rowsIn(channelId: string): (typeof schema.messages.$inferSelect)[] {
      return testDb.select().from(schema.messages).where(eq(schema.messages.channelId, channelId)).all();
    }

    it('accepts a reply target in the same channel', async () => {
      // Positive control for the "persists nothing" assertions below.
      const { handleClientEvent } = await import('../ws/events.js');
      const targetId = seedMessage(GENERAL, 'victim', 'in-channel target');

      handleClientEvent(
        { type: 'message_create', channelId: GENERAL, content: 'hi', replyToId: targetId },
        'attacker',
        'attacker',
        {} as never,
        false,
      );

      const rows = rowsIn(GENERAL);
      expect(rows).toHaveLength(2);
      const created = rows.find(m => m.id !== targetId);
      expect(created?.replyToId).toBe(targetId);
      expect(sendToChannel).toHaveBeenCalled();
    });

    it('rejects a reply target in a channel the caller cannot read and persists nothing', async () => {
      const { handleClientEvent } = await import('../ws/events.js');

      handleClientEvent(
        { type: 'message_create', channelId: GENERAL, content: 'hi', replyToId: secretMessageId },
        'attacker',
        'attacker',
        {} as never,
        false,
      );

      expect(rowsIn(GENERAL)).toHaveLength(0);
      expect(sendToUser).toHaveBeenCalledWith('attacker', {
        type: 'error',
        message: 'Invalid reply target',
      });
    });

    it('rejects a reply target in a sibling channel and persists nothing', async () => {
      const { handleClientEvent } = await import('../ws/events.js');

      handleClientEvent(
        { type: 'message_create', channelId: GENERAL, content: 'hi', replyToId: loungeMessageId },
        'attacker',
        'attacker',
        {} as never,
        false,
      );

      expect(rowsIn(GENERAL)).toHaveLength(0);
      expect(sendToUser).toHaveBeenCalledWith('attacker', {
        type: 'error',
        message: 'Invalid reply target',
      });
    });
  });

  describe('hydration of pre-existing cross-channel rows', () => {
    // Simulates rows written before the create-time rule existed.
    let poisonedId: string;
    let cleanId: string;
    let cleanTargetId: string;

    beforeEach(() => {
      cleanTargetId = seedMessage(GENERAL, 'victim', 'in-channel target');
      poisonedId = seedMessage(GENERAL, 'attacker', 'look at this', secretMessageId);
      cleanId = seedMessage(GENERAL, 'attacker', 'ordinary reply', cleanTargetId);
    });

    it('does not hydrate the foreign message in GET /api/channels/:id/messages', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/channels/${GENERAL}/messages` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<{ id: string; replyTo: { id: string } | null }>;

      const poisoned = body.find(m => m.id === poisonedId);
      expect(poisoned).toBeDefined();
      expect(poisoned!.replyTo).toBeNull();

      // Positive control: the same read path still hydrates an in-channel target.
      const clean = body.find(m => m.id === cleanId);
      expect(clean).toBeDefined();
      expect(clean!.replyTo?.id).toBe(cleanTargetId);
    });

    it('does not hydrate the foreign message in GET /api/channels/:id/search', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/channels/${GENERAL}/search?q=reply` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { results: Array<{ id: string; replyTo: { id: string } | null }> };

      const poisonedRes = await app.inject({ method: 'GET', url: `/api/channels/${GENERAL}/search?q=look` });
      const poisonedBody = JSON.parse(poisonedRes.body) as { results: Array<{ id: string; replyTo: { id: string } | null }> };
      const poisoned = poisonedBody.results.find(m => m.id === poisonedId);
      expect(poisoned).toBeDefined();
      expect(poisoned!.replyTo).toBeNull();

      // Positive control.
      const clean = body.results.find(m => m.id === cleanId);
      expect(clean).toBeDefined();
      expect(clean!.replyTo?.id).toBe(cleanTargetId);
    });

    it('does not hydrate the foreign message in GET /api/channels/:id/messages/around', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${GENERAL}/messages/around?messageId=${poisonedId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<{ id: string; replyTo: { id: string } | null }>;

      const poisoned = body.find(m => m.id === poisonedId);
      expect(poisoned).toBeDefined();
      expect(poisoned!.replyTo).toBeNull();

      // Positive control.
      const clean = body.find(m => m.id === cleanId);
      expect(clean).toBeDefined();
      expect(clean!.replyTo?.id).toBe(cleanTargetId);
    });

    it('does not hydrate the foreign message in PATCH /api/messages/:id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${poisonedId}`,
        payload: { content: 'edited' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).replyTo).toBeNull();

      // Positive control: the same edit path hydrates an in-channel target.
      const cleanRes = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${cleanId}`,
        payload: { content: 'edited too' },
      });
      expect(cleanRes.statusCode).toBe(200);
      expect(JSON.parse(cleanRes.body).replyTo?.id).toBe(cleanTargetId);
    });

    it('does not hydrate the foreign message in the WS message_edit broadcast', async () => {
      const { handleClientEvent } = await import('../ws/events.js');

      handleClientEvent(
        { type: 'message_edit', messageId: poisonedId, content: 'edited' },
        'attacker',
        'attacker',
        {} as never,
        false,
      );

      const poisonedCall = sendToChannel.mock.calls.find(
        call => (call[2] as { message?: { id: string } }).message?.id === poisonedId,
      );
      expect(poisonedCall).toBeDefined();
      expect((poisonedCall![2] as { message: { replyTo: unknown } }).message.replyTo).toBeNull();

      // Positive control: the same broadcast carries an in-channel target.
      handleClientEvent(
        { type: 'message_edit', messageId: cleanId, content: 'edited too' },
        'attacker',
        'attacker',
        {} as never,
        false,
      );

      const cleanCall = sendToChannel.mock.calls.find(
        call => (call[2] as { message?: { id: string } }).message?.id === cleanId,
      );
      expect(cleanCall).toBeDefined();
      expect((cleanCall![2] as { message: { replyTo: { id: string } | null } }).message.replyTo?.id).toBe(cleanTargetId);
    });
  });
});
