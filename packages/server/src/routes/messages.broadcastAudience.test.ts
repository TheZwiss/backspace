import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId, generateSnowflake } from '../utils/snowflake.js';
import type { ServerEvent } from '@backspace/shared';
import {
  PermissionBits,
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsToString,
} from '@backspace/shared/src/permissions.js';

setWorkerId(3);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'author';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
  verifyJwt: vi.fn(),
}));

// Embed resolution performs network work and is unrelated to broadcast audience.
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

const SPACE = 'space-audience';
const OPEN = 'chan-open';
const RESTRICTED = 'chan-restricted';

function seedUser(id: string): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    displayName: null,
    passwordHash: 'x',
    status: 'offline',
    isAdmin: 0,
    isDeleted: 0,
    discoverable: 1,
    homeInstance: null,
    homeUserId: null,
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
  // @everyone role carries the default member permissions, VIEW_CHANNEL included.
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

/** Deny one member VIEW_CHANNEL on one channel, leaving the rest of the space untouched. */
function denyMemberRead(channelId: string, userId: string): void {
  testDb.insert(schema.channelOverrides).values({
    channelId,
    targetType: 'member',
    targetId: userId,
    allow: '0',
    deny: permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY),
  }).run();
}

function seedMessage(channelId: string, userId: string, content: string): string {
  const id = generateSnowflake();
  testDb.insert(schema.messages).values({
    id,
    channelId,
    userId,
    replyToId: null,
    content,
    createdAt: Date.now(),
  }).run();
  return id;
}

/**
 * Minimal stand-in for a live client socket. The real connectionManager is used
 * throughout this file, so what lands here is what a real client would receive.
 */
interface FakeSocket {
  readyState: number;
  send: (raw: string) => void;
  received: ServerEvent[];
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    readyState: 1,
    send: (raw: string) => { socket.received.push(JSON.parse(raw) as ServerEvent); },
    received: [],
  };
  return socket;
}

function eventsOfType(socket: FakeSocket, type: string): ServerEvent[] {
  return socket.received.filter(e => e.type === type);
}

const sockets: Record<'owner' | 'author' | 'viewer' | 'denied', FakeSocket> = {
  owner: fakeSocket(),
  author: fakeSocket(),
  viewer: fakeSocket(),
  denied: fakeSocket(),
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { messageRoutes } = await import('./messages.js');
  const { channelRoutes } = await import('./channels.js');
  await app.register(messageRoutes);
  await app.register(channelRoutes);
  await app.ready();
  return app;
}

describe('channel message events reach only the channel audience', () => {
  let app: FastifyInstance;
  let openMessageId: string;
  let restrictedMessageId: string;

  beforeAll(async () => {
    const { connectionManager } = await import('../ws/handler.js');
    // Registered once: connectionManager state is process-wide and independent of
    // the per-test database, and tearing sockets down would run the disconnect
    // timers this file has no use for.
    for (const [userId, socket] of Object.entries(sockets)) {
      connectionManager.addConnection(userId, socket as unknown as WebSocket);
      connectionManager.setUserSpaces(userId, [SPACE]);
    }
  });

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    testDb = drizzle(sqlite, { schema });

    seedUser('owner');
    seedUser('author');
    seedUser('viewer');
    seedUser('denied');

    seedSpace(SPACE, 'owner', ['author', 'viewer', 'denied']);
    seedChannel(OPEN, SPACE);
    seedChannel(RESTRICTED, SPACE);
    // Only `denied` loses read access, and only on the restricted channel.
    denyMemberRead(RESTRICTED, 'denied');

    openMessageId = seedMessage(OPEN, 'author', 'open channel content');
    restrictedMessageId = seedMessage(RESTRICTED, 'author', 'restricted channel content');

    for (const socket of Object.values(sockets)) {
      socket.received.length = 0;
    }

    currentUserId = 'author';
    app = await buildApp();
  });

  describe('fixture controls', () => {
    it('the denied member can read the open channel', async () => {
      currentUserId = 'denied';
      const res = await app.inject({ method: 'GET', url: `/api/channels/${OPEN}/messages` });
      expect(res.statusCode).toBe(200);
    });

    it('the denied member cannot read the restricted channel', async () => {
      currentUserId = 'denied';
      const res = await app.inject({ method: 'GET', url: `/api/channels/${RESTRICTED}/messages` });
      expect(res.statusCode).toBe(403);
    });

    it('the viewer can read the restricted channel', async () => {
      currentUserId = 'viewer';
      const res = await app.inject({ method: 'GET', url: `/api/channels/${RESTRICTED}/messages` });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('positive controls: the harness observes events it should observe', () => {
    it('an edit in a channel everyone can read reaches the denied member too', async () => {
      currentUserId = 'author';
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${openMessageId}`,
        payload: { content: 'edited in the open channel' },
      });

      expect(res.statusCode).toBe(200);
      const delivered = eventsOfType(sockets.denied, 'message_updated');
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        message: { id: openMessageId, content: 'edited in the open channel' },
      });
      expect(eventsOfType(sockets.viewer, 'message_updated')).toHaveLength(1);
    });

    it('a delete in a channel everyone can read reaches the denied member too', async () => {
      currentUserId = 'author';
      const res = await app.inject({ method: 'DELETE', url: `/api/messages/${openMessageId}` });

      expect(res.statusCode).toBe(200);
      expect(eventsOfType(sockets.denied, 'message_deleted')).toEqual([
        { type: 'message_deleted', messageId: openMessageId, channelId: OPEN },
      ]);
      expect(eventsOfType(sockets.viewer, 'message_deleted')).toHaveLength(1);
    });

    it('a genuinely space-wide event still reaches a member denied one channel', async () => {
      // category_created is space furniture, not channel content. It must keep
      // going to every member, so this proves the fix does not over-suppress.
      currentUserId = 'owner';
      const res = await app.inject({
        method: 'POST',
        url: `/api/spaces/${SPACE}/categories`,
        payload: { name: 'General' },
      });

      expect(res.statusCode).toBe(201);
      expect(eventsOfType(sockets.denied, 'category_created')).toHaveLength(1);
      expect(eventsOfType(sockets.viewer, 'category_created')).toHaveLength(1);
    });
  });

  describe('PATCH /api/messages/:id', () => {
    it('does not send message_updated to a member denied VIEW_CHANNEL', async () => {
      currentUserId = 'author';
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${restrictedMessageId}`,
        payload: { content: 'edited in the restricted channel' },
      });

      expect(res.statusCode).toBe(200);
      expect(eventsOfType(sockets.denied, 'message_updated')).toEqual([]);
      // The denied member must not learn the content by any route.
      const raw = JSON.stringify(sockets.denied.received);
      expect(raw).not.toContain('edited in the restricted channel');
    });

    it('still sends message_updated to members who can read the channel', async () => {
      currentUserId = 'author';
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/messages/${restrictedMessageId}`,
        payload: { content: 'edited in the restricted channel' },
      });

      expect(res.statusCode).toBe(200);
      const delivered = eventsOfType(sockets.viewer, 'message_updated');
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        message: { id: restrictedMessageId, content: 'edited in the restricted channel' },
      });
      expect(eventsOfType(sockets.owner, 'message_updated')).toHaveLength(1);
      expect(eventsOfType(sockets.author, 'message_updated')).toHaveLength(1);
    });
  });

  describe('DELETE /api/messages/:id', () => {
    it('does not send message_deleted to a member denied VIEW_CHANNEL', async () => {
      currentUserId = 'author';
      const res = await app.inject({ method: 'DELETE', url: `/api/messages/${restrictedMessageId}` });

      expect(res.statusCode).toBe(200);
      expect(eventsOfType(sockets.denied, 'message_deleted')).toEqual([]);
      const raw = JSON.stringify(sockets.denied.received);
      expect(raw).not.toContain(restrictedMessageId);
    });

    it('still sends message_deleted to members who can read the channel', async () => {
      currentUserId = 'author';
      const res = await app.inject({ method: 'DELETE', url: `/api/messages/${restrictedMessageId}` });

      expect(res.statusCode).toBe(200);
      expect(eventsOfType(sockets.viewer, 'message_deleted')).toEqual([
        { type: 'message_deleted', messageId: restrictedMessageId, channelId: RESTRICTED },
      ]);
      expect(eventsOfType(sockets.owner, 'message_deleted')).toHaveLength(1);
      expect(eventsOfType(sockets.author, 'message_deleted')).toHaveLength(1);
    });
  });
});
