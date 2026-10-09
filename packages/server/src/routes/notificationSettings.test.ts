import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NotificationSetting, NotificationSettingsResponse } from '@backspace/shared';
import { DEFAULT_EVERYONE_PERMISSIONS, PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'member';

const sendToUser = vi.fn();

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
    sendToUser: (...args: unknown[]) => sendToUser(...args),
  },
}));

function applyMigrations(db: Database.Database, through?: string): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql') && (!through || f <= through)).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const SPACE_ID = 'space-1';
const OTHER_SPACE_ID = 'space-2';
const CHANNEL_ID = 'chan-1';
const HIDDEN_CHANNEL_ID = 'chan-hidden';

interface ErrorBody { code?: string; statusCode: number }

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const { notificationSettingsRoutes } = await import('./notificationSettings.js');
  const f = Fastify();
  await f.register(notificationSettingsRoutes);
  return f;
}

function addSpace(id: string, ownerId: string): void {
  testDb.insert(schema.spaces).values({ id, name: id, ownerId, createdAt: NOW }).run();
  testDb.insert(schema.roles).values({
    id,
    spaceId: id,
    name: '@everyone',
    position: 0,
    permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
    createdAt: NOW,
  }).run();
}

function addChannel(id: string, spaceId: string): void {
  testDb.insert(schema.channels).values({ id, spaceId, name: id, type: 'text', createdAt: NOW }).run();
}

function addMember(spaceId: string, userId: string): void {
  testDb.insert(schema.spaceMembers).values({ spaceId, userId, joinedAt: NOW }).run();
}

function rows(): Array<typeof schema.notificationSettings.$inferSelect> {
  return testDb.select().from(schema.notificationSettings).all();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  sendToUser.mockReset();
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  currentUserId = 'member';

  for (const id of ['owner', 'member', 'outsider']) {
    testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: NOW }).run();
  }
  addSpace(SPACE_ID, 'owner');
  addSpace(OTHER_SPACE_ID, 'owner');
  addMember(SPACE_ID, 'owner');
  addMember(SPACE_ID, 'member');
  addMember(OTHER_SPACE_ID, 'owner');
  addChannel(CHANNEL_ID, SPACE_ID);
  addChannel(HIDDEN_CHANNEL_ID, SPACE_ID);
  // @everyone cannot see the hidden channel.
  testDb.insert(schema.channelOverrides).values({
    channelId: HIDDEN_CHANNEL_ID,
    targetType: 'role',
    targetId: SPACE_ID,
    allow: '0',
    deny: PermissionBits.VIEW_CHANNEL.toString(),
  }).run();

  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  vi.useRealTimers();
});

describe('PATCH /api/spaces/:spaceId/notification-settings', () => {
  it('stores the level and pushes the setting to the user', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'all' } });
    expect(res.statusCode).toBe(200);
    const setting = res.json<NotificationSetting>();
    expect(setting).toEqual({ suppressEveryone: false, suppressRoles: false, spaceId: SPACE_ID, channelId: null, level: 'all', muted: false, mutedUntil: null, updatedAt: NOW });
    expect(rows()).toHaveLength(1);
    expect(sendToUser).toHaveBeenCalledWith('member', { type: 'notification_settings_updated', setting });
  });

  it('turns a mute duration into an end time on the server clock', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { mute: '8h' } });
    expect(res.json<NotificationSetting>()).toMatchObject({ level: null, muted: true, mutedUntil: NOW + 8 * HOUR });
  });

  it('stores an indefinite mute without an end', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { mute: 'indefinite' } });
    expect(res.json<NotificationSetting>()).toMatchObject({ muted: true, mutedUntil: null });
  });

  it('keeps the level when only the mute changes, and the mute when only the level changes', async () => {
    await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'nothing' } });
    vi.setSystemTime(NOW + 1000);
    await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { mute: '1h' } });
    vi.setSystemTime(NOW + 2000);
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'all' } });
    expect(res.json<NotificationSetting>()).toMatchObject({ level: 'all', muted: true, mutedUntil: NOW + 1000 + HOUR });
    expect(rows()).toHaveLength(1);
  });

  it('deletes the row when nothing is chosen any more and says so', async () => {
    await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'all', mute: '24h' } });
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: null, mute: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json<NotificationSetting>()).toMatchObject({ level: null, muted: false, mutedUntil: null });
    expect(rows()).toHaveLength(0);
    expect(sendToUser).toHaveBeenLastCalledWith('member', expect.objectContaining({ type: 'notification_settings_updated' }));
  });

  it('drops a mute that has already ended instead of carrying it over', async () => {
    await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { mute: '1h' } });
    vi.setSystemTime(NOW + 2 * HOUR);
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'all' } });
    expect(res.json<NotificationSetting>()).toMatchObject({ level: 'all', muted: false, mutedUntil: null });
  });

  it('gives every write a later updatedAt than the stored one, even in the same millisecond', async () => {
    const first = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'all' } });
    const second = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'nothing' } });
    expect(second.json<NotificationSetting>().updatedAt).toBeGreaterThan(first.json<NotificationSetting>().updatedAt);
  });

  it.each([
    [{}],
    [{ level: 'loud' }],
    [{ mute: '2h' }],
    [{ level: 3 }],
    [[]],
  ])('refuses the body %j with validation_failed', async (payload) => {
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().code).toBe('validation_failed');
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('answers space_not_found for an unknown space', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/spaces/nope/notification-settings', payload: { level: 'all' } });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorBody>().code).toBe('space_not_found');
  });

  it('refuses a non-member with not_space_member', async () => {
    currentUserId = 'outsider';
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'all' } });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().code).toBe('not_space_member');
    expect(rows()).toHaveLength(0);
  });
});

describe('PATCH /api/channels/:channelId/notification-settings', () => {
  it('stores a channel row beside the space row', async () => {
    await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'nothing' } });
    const res = await app.inject({ method: 'PATCH', url: `/api/channels/${CHANNEL_ID}/notification-settings`, payload: { level: 'all' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<NotificationSetting>()).toMatchObject({ spaceId: SPACE_ID, channelId: CHANNEL_ID, level: 'all' });
    expect(rows()).toHaveLength(2);
  });

  it('lets a channel be muted while it inherits the level', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/channels/${CHANNEL_ID}/notification-settings`, payload: { mute: '1h' } });
    expect(res.json<NotificationSetting>()).toMatchObject({ level: null, muted: true, mutedUntil: NOW + HOUR });
  });

  it('answers channel_not_found for an unknown channel', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/channels/nope/notification-settings', payload: { level: 'all' } });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorBody>().code).toBe('channel_not_found');
  });

  it('refuses a channel the caller cannot see', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/channels/${HIDDEN_CHANNEL_ID}/notification-settings`, payload: { level: 'all' } });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().code).toBe('missing_permission');
  });

  it('refuses a non-member', async () => {
    currentUserId = 'outsider';
    const res = await app.inject({ method: 'PATCH', url: `/api/channels/${CHANNEL_ID}/notification-settings`, payload: { level: 'all' } });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().code).toBe('not_space_member');
  });

  it('goes away with its channel', async () => {
    await app.inject({ method: 'PATCH', url: `/api/channels/${CHANNEL_ID}/notification-settings`, payload: { level: 'all' } });
    testDb.delete(schema.channels).run();
    expect(rows()).toHaveLength(0);
  });
});

describe('GET /api/users/@me/notification-settings', () => {
  it('lists only the caller\'s settings', async () => {
    await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'all' } });
    currentUserId = 'owner';
    await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'nothing' } });
    currentUserId = 'member';
    const res = await app.inject({ method: 'GET', url: '/api/users/@me/notification-settings' });
    expect(res.statusCode).toBe(200);
    const { settings } = res.json<NotificationSettingsResponse>();
    expect(settings).toEqual([expect.objectContaining({ spaceId: SPACE_ID, channelId: null, level: 'all' })]);
  });

  it('leaves out spaces the caller left and channels they can no longer see', async () => {
    await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/notification-settings`, payload: { level: 'all' } });
    // Stored while the channel was visible; an override hid it since.
    testDb.insert(schema.notificationSettings).values({
      userId: 'member', spaceId: SPACE_ID, channelId: HIDDEN_CHANNEL_ID, level: 'all', muted: 0, updatedAt: NOW,
    }).run();
    testDb.insert(schema.notificationSettings).values({
      userId: 'member', spaceId: OTHER_SPACE_ID, channelId: null, level: 'nothing', muted: 0, updatedAt: NOW,
    }).run();
    const res = await app.inject({ method: 'GET', url: '/api/users/@me/notification-settings' });
    const { settings } = res.json<NotificationSettingsResponse>();
    expect(settings.map((s) => [s.spaceId, s.channelId])).toEqual([[SPACE_ID, null]]);
  });
});

describe('notification_settings uniqueness', () => {
  it('allows one space row and one row per channel per user', () => {
    const insert = (channelId: string | null) => testDb.insert(schema.notificationSettings).values({
      userId: 'member', spaceId: SPACE_ID, channelId, level: 'all', muted: 0, updatedAt: NOW,
    }).run();
    insert(null);
    insert(CHANNEL_ID);
    expect(() => insert(null)).toThrow(/UNIQUE/);
    expect(() => insert(CHANNEL_ID)).toThrow(/UNIQUE/);
  });
});


describe('space-wide mass mention preferences', () => {
  const url = '/api/spaces/' + SPACE_ID + '/notification-settings';

  it('persists a suppression-only row, pushes it, and returns it on reload', async () => {
    const res = await app.inject({ method: 'PATCH', url, payload: { suppressEveryone: true, suppressRoles: true } });
    expect(res.statusCode).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ suppressEveryone: 1, suppressRoles: 1, level: null });
    expect(sendToUser).toHaveBeenCalledWith('member', { type: 'notification_settings_updated', setting: res.json() });
    const reload = await app.inject({ method: 'GET', url: '/api/users/@me/notification-settings' });
    expect(reload.json().settings).toEqual([res.json()]);
  });

  it('preserves suppression across level/mute changes and deletes only when everything resets', async () => {
    await app.inject({ method: 'PATCH', url, payload: { suppressEveryone: true, mute: '1h' } });
    const changed = await app.inject({ method: 'PATCH', url, payload: { level: 'all', mute: null } });
    expect(changed.json()).toMatchObject({ suppressEveryone: true, suppressRoles: false, level: 'all', muted: false });
    await app.inject({ method: 'PATCH', url, payload: { level: null } });
    expect(rows()).toHaveLength(1);
    const cleared = await app.inject({ method: 'PATCH', url, payload: { suppressEveryone: false } });
    expect(cleared.json()).toMatchObject({ suppressEveryone: false, suppressRoles: false, level: null });
    expect(rows()).toHaveLength(0);
  });

  it.each([{ suppressEveryone: null }, { suppressRoles: 1 }, { suppressEveryone: 'true' }])('rejects malformed suppression atomically: %j', async (payload) => {
    const res = await app.inject({ method: 'PATCH', url, payload: { level: 'all', ...payload } });
    expect(res.statusCode).toBe(400);
    expect(rows()).toHaveLength(0);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it.each(['suppressEveryone', 'suppressRoles'])('rejects channel overrides of %s', async (field) => {
    const res = await app.inject({ method: 'PATCH', url: '/api/channels/' + CHANNEL_ID + '/notification-settings', payload: { level: 'all', [field]: false } });
    expect(res.statusCode).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('does not allow non-members to set suppression', async () => {
    currentUserId = 'outsider';
    const res = await app.inject({ method: 'PATCH', url, payload: { suppressRoles: true } });
    expect(res.statusCode).toBe(403);
    expect(rows()).toHaveLength(0);
  });
});


describe('mass-mention preference migration', () => {
  it('upgrades upstream rows without changing level or mute choices', () => {
    const upgrade = new Database(':memory:');
    const migrationsDir = path.resolve(__dirname, '../../drizzle');
    try {
      // Exercise the exact pre-feature schema, rather than a hand-written approximation.
      applyMigrations(upgrade, '0026_notification_settings.sql');
      const previousDb = drizzle(upgrade, { schema });
      previousDb.insert(schema.users).values({ id: 'member', username: 'member', passwordHash: 'x', createdAt: NOW }).run();
      previousDb.insert(schema.spaces).values({ id: 'space', name: 'space', ownerId: 'member', createdAt: NOW }).run();
      previousDb.insert(schema.channels).values({ id: 'channel', spaceId: 'space', name: 'channel', type: 'text', createdAt: NOW }).run();
      upgrade.prepare('INSERT INTO notification_settings (user_id, space_id, channel_id, level, muted, muted_until, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('member', 'space', null, 'mentions', 1, NOW + HOUR, NOW);
      upgrade.prepare('INSERT INTO notification_settings (user_id, space_id, channel_id, level, muted, muted_until, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('member', 'space', 'channel', 'nothing', 0, null, NOW);
      const previous = upgrade.prepare('SELECT * FROM notification_settings ORDER BY channel_id').all();
      upgrade.exec(fs.readFileSync(path.join(migrationsDir, '0027_mass_mention_preferences.sql'), 'utf8'));
      const upgraded = upgrade.prepare('SELECT * FROM notification_settings ORDER BY channel_id').all();
      expect(upgraded).toEqual(previous.map(row => ({ ...(row as Record<string, unknown>), suppress_everyone: 0, suppress_roles: 0 })));
    } finally {
      upgrade.close();
    }
  });
});
