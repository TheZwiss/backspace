import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
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
import { MAX_MESSAGE_LENGTH } from '@backspace/shared';

setWorkerId(3);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'member';

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

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToChannel: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToRoom: vi.fn(),
    sendToAdmins: vi.fn(),
    getUserRoom: () => undefined,
    getRoom: () => undefined,
    getAllRooms: () => new Map(),
    getAllOnlineUserIds: () => [],
  },
}));

vi.mock('../ws/events.js', () => ({
  checkVoicePermissions: vi.fn(),
}));

vi.mock('../utils/fileCleanup.js', () => ({
  deleteAttachmentFiles: vi.fn(async () => {}),
}));

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
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const NOW = 1_700_000_000_000;
const SPACE = 'space-1';
const OTHER_SPACE = 'space-2';
const GENERAL = 'chan-general';
const SECRET = 'chan-secret';

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

function denyEveryoneRead(channelId: string, spaceId: string): void {
  testDb.insert(schema.channelOverrides).values({
    channelId,
    targetType: 'role',
    targetId: spaceId,
    allow: '0',
    deny: permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY),
  }).run();
}

function seedMessage(channelId: string, userId: string, content: string): string {
  const id = generateSnowflake();
  testDb.insert(schema.messages).values({ id, channelId, userId, replyToId: null, content, createdAt: Date.now() }).run();
  return id;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { channelRoutes } = await import('./channels.js');
  const { messageRoutes } = await import('./messages.js');
  await app.register(channelRoutes);
  await app.register(messageRoutes);
  await app.ready();
  return app;
}

interface ErrorBody {
  error: string;
  statusCode: number;
  code?: string;
  details?: Record<string, string | number>;
}

describe('channel and message routes send error codes', () => {
  let app: FastifyInstance;
  let ownersMessageId: string;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    testDb = drizzle(sqlite, { schema });

    seedUser('owner');
    seedUser('member');
    seedUser('stranger');
    seedSpace(SPACE, 'owner', ['owner', 'member']);
    seedChannel(GENERAL, SPACE);
    seedChannel(SECRET, SPACE);
    denyEveryoneRead(SECRET, SPACE);
    seedSpace(OTHER_SPACE, 'stranger', ['stranger']);
    ownersMessageId = seedMessage(GENERAL, 'owner', 'hello');

    currentUserId = 'member';
    app = await buildApp();
  });

  describe('messages', () => {
    it('unknown channel → channel_not_found, keeping the legacy text', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/channels/nope/messages' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as ErrorBody;
      expect(body.code).toBe('channel_not_found');
      expect(body.error).toBe('Channel not found');
      expect(body.statusCode).toBe(404);
    });

    it('unreadable channel → missing_permission naming the permission', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/channels/${SECRET}/messages` });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as ErrorBody;
      expect(body.code).toBe('missing_permission');
      expect(body.details).toEqual({ permission: 'VIEW_CHANNEL or READ_MESSAGE_HISTORY' });
      expect(body.error).toBe('Missing VIEW_CHANNEL or READ_MESSAGE_HISTORY permission');
    });

    it('empty message → message_empty', async () => {
      const res = await app.inject({ method: 'POST', url: `/api/channels/${GENERAL}/messages`, payload: {} });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as ErrorBody).code).toBe('message_empty');
    });

    it('oversized message → content_too_long with the limit in details', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${GENERAL}/messages`,
        payload: { content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as ErrorBody;
      expect(body.code).toBe('content_too_long');
      expect(body.details).toEqual({ max: MAX_MESSAGE_LENGTH });
      expect(body.error).toBe(`Message content must be ${MAX_MESSAGE_LENGTH} characters or less`);
    });

    it("editing another user's message → message_edit_not_author", async () => {
      const res = await app.inject({ method: 'PATCH', url: `/api/messages/${ownersMessageId}`, payload: { content: 'mine now' } });
      expect(res.statusCode).toBe(403);
      expect((JSON.parse(res.body) as ErrorBody).code).toBe('message_edit_not_author');
    });

    it('editing an unknown message → message_not_found', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/api/messages/nope', payload: { content: 'x' } });
      expect(res.statusCode).toBe(404);
      expect((JSON.parse(res.body) as ErrorBody).code).toBe('message_not_found');
    });

    it('editing with empty content → content_required', async () => {
      const res = await app.inject({ method: 'PATCH', url: `/api/messages/${ownersMessageId}`, payload: { content: '   ' } });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as ErrorBody).code).toBe('content_required');
    });
  });

  describe('channels and categories', () => {
    it('unknown space → space_not_found', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/spaces/nope/channels', payload: { name: 'x' } });
      expect(res.statusCode).toBe(404);
      expect((JSON.parse(res.body) as ErrorBody).code).toBe('space_not_found');
    });

    it('listing channels of a space the caller has not joined → not_space_member', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/spaces/${OTHER_SPACE}/channels` });
      expect(res.statusCode).toBe(403);
      expect((JSON.parse(res.body) as ErrorBody).code).toBe('not_space_member');
    });

    it('deleting a channel without MANAGE_CHANNELS → missing_permission', async () => {
      const res = await app.inject({ method: 'DELETE', url: `/api/channels/${GENERAL}` });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as ErrorBody;
      expect(body.code).toBe('missing_permission');
      expect(body.details).toEqual({ permission: 'MANAGE_CHANNELS' });
    });

    it('creating a channel without a name → channel_name_required', async () => {
      currentUserId = 'owner';
      const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE}/channels`, payload: {} });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as ErrorBody).code).toBe('channel_name_required');
    });

    it('creating a channel with a too-long name → channel_name_length with the bounds', async () => {
      currentUserId = 'owner';
      const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE}/channels`, payload: { name: 'x'.repeat(101) } });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as ErrorBody;
      expect(body.code).toBe('channel_name_length');
      expect(body.details).toEqual({ min: 1, max: 100 });
    });

    it('creating a channel in a category of another space → category_not_in_space with the id', async () => {
      currentUserId = 'owner';
      const res = await app.inject({
        method: 'POST',
        url: `/api/spaces/${SPACE}/channels`,
        payload: { name: 'x', type: 'text', categoryId: 'nope' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as ErrorBody;
      expect(body.code).toBe('category_not_in_space');
      expect(body.details).toEqual({ id: 'nope' });
    });

    it('updating an unknown category → category_not_found', async () => {
      currentUserId = 'owner';
      const res = await app.inject({ method: 'PATCH', url: '/api/categories/nope', payload: { name: 'x' } });
      expect(res.statusCode).toBe(404);
      expect((JSON.parse(res.body) as ErrorBody).code).toBe('category_not_found');
    });

    it('override with a bad target type → override_target_invalid', async () => {
      currentUserId = 'owner';
      const res = await app.inject({
        method: 'PUT',
        url: `/api/channels/${GENERAL}/overrides`,
        payload: { targetType: 'planet', targetId: 'x', allow: '0', deny: '0' },
      });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as ErrorBody).code).toBe('override_target_invalid');
    });
  });
});
