import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsToString,
} from '@backspace/shared/src/permissions.js';

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
const GENERAL = 'chan-general';

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


const defaults = { level: null, mutedUntil: null, suppressEveryone: false, suppressRoles: false };
const url = '/api/users/@me/notification-settings';

describe('notification settings persistence and isolation', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    testDb = drizzle(sqlite, { schema });
    for (const id of ['owner', 'member', 'stranger']) seedUser(id);
    seedSpace(SPACE, 'owner', ['owner', 'member']);
    seedChannel(GENERAL, SPACE);
    currentUserId = 'member';
    app = Fastify();
    const { notificationSettingsRoutes } = await import('./notificationSettings.js');
    await app.register(notificationSettingsRoutes);
    const { messageRoutes } = await import('./messages.js');
    await app.register(messageRoutes);
    await app.ready();
  });
  afterEach(async () => { await app.close(); sqlite.close(); });

  it('upserts only the authenticated user and pushes the confirmed value to their devices', async () => {
    const { connectionManager } = await import('../ws/handler.js');
    for (const level of ['all', 'mentions']) {
      const response = await app.inject({ method: 'PUT', url: url + '/space/' + SPACE, payload: { ...defaults, level } });
      expect(response.statusCode).toBe(200);
      expect(connectionManager.sendToUser).toHaveBeenLastCalledWith('member', {
        type: 'notification_setting_updated', setting: response.json(),
      });
    }
    const saved = (await app.inject({ method: 'GET', url })).json();
    expect(saved).toEqual([{ ...defaults, targetType: 'space', targetId: SPACE, level: 'mentions' }]);
    currentUserId = 'owner';
    expect((await app.inject({ method: 'GET', url })).json()).toEqual([]);
    expect(testDb.select().from(schema.notificationSettings).all()).toHaveLength(1);
  });

  it.each([
    ['space/missing', {}, 404], ['channel/missing', {}, 404], ['invalid/id', {}, 400],
    ['space/' + SPACE, { level: 'invalid' }, 400],
    ['space/' + SPACE, { mutedUntil: -1 }, 400],
    ['space/' + SPACE, { mutedUntil: 1.5 }, 400],
    ['space/' + SPACE, { mutedUntil: Number.MAX_SAFE_INTEGER + 1 }, 400],
    ['space/' + SPACE, { suppressRoles: 'true' }, 400],
    ['channel/' + GENERAL, { suppressEveryone: true }, 400],
    ['channel/' + GENERAL, { suppressRoles: true }, 400],
  ])('rejects invalid target or fields: %s %j', async (target, override, status) => {
    const response = await app.inject({ method: 'PUT', url: url + '/' + target, payload: { ...defaults, ...override } });
    expect(response.statusCode).toBe(status);
    expect(testDb.select().from(schema.notificationSettings).all()).toEqual([]);
  });

  it('rejects nonmembers for both target types', async () => {
    currentUserId = 'stranger';
    for (const target of ['space/' + SPACE, 'channel/' + GENERAL]) {
      const response = await app.inject({ method: 'PUT', url: url + '/' + target, payload: defaults });
      expect(response.statusCode).toBe(403);
    }
  });

  it.each(['@everyone', '@here', '<@&team>'])('enforces mass mention permission on REST create and edit: %s', async content => {
    const create = await app.inject({ method: 'POST', url: '/api/channels/' + GENERAL + '/messages', payload: { content } });
    expect(create.statusCode).toBe(403);
    expect(create.json().details).toEqual({ permission: 'MENTION_EVERYONE' });
    testDb.insert(schema.messages).values({ id: 'existing', channelId: GENERAL, userId: 'member', content: 'original', createdAt: NOW }).run();
    const update = await app.inject({ method: 'PATCH', url: '/api/messages/existing', payload: { content } });
    expect(update.statusCode).toBe(403);
    expect(testDb.select().from(schema.messages).all()[0]!.content).toBe('original');
  });

  it.each(['@everyone', '@here', '<@&team>'])('enforces mass mention permission on WebSocket create and edit: %s', async content => {
    const { handleClientEvent } = await import('../ws/events.js');
    const { connectionManager } = await import('../ws/handler.js');
    const socket = {} as Parameters<typeof handleClientEvent>[3];
    handleClientEvent({ type: 'message_create', channelId: GENERAL, content }, 'member', 'member', socket, false);
    expect(testDb.select().from(schema.messages).all()).toEqual([]);
    testDb.insert(schema.messages).values({ id: 'existing', channelId: GENERAL, userId: 'member', content: 'original', createdAt: NOW }).run();
    handleClientEvent({ type: 'message_edit', messageId: 'existing', content }, 'member', 'member', socket, false);
    expect(testDb.select().from(schema.messages).all()[0]!.content).toBe('original');
    expect(connectionManager.sendToUser).toHaveBeenLastCalledWith('member', { type: 'error', message: 'Missing MENTION_EVERYONE permission' });
  });

  it('allows an owner to send a mass mention and a member to quote one in code', async () => {
    currentUserId = 'owner';
    const allowed = await app.inject({ method: 'POST', url: '/api/channels/' + GENERAL + '/messages', payload: { content: '@everyone' } });
    expect(allowed.statusCode).toBe(201);
    currentUserId = 'member';
    const quoted = await app.inject({ method: 'POST', url: '/api/channels/' + GENERAL + '/messages', payload: { content: '\x60@everyone\x60' } });
    expect(quoted.statusCode).toBe(201);
  });

  it('round-trips permanent mute and channel inheritance independently', async () => {
    const payload = { ...defaults, mutedUntil: Number.MAX_SAFE_INTEGER };
    const response = await app.inject({ method: 'PUT', url: url + '/channel/' + GENERAL, payload });
    expect(response.json()).toEqual({ ...payload, targetType: 'channel', targetId: GENERAL });
    expect((await app.inject({ method: 'GET', url })).json()).toEqual([response.json()]);
  });
});
