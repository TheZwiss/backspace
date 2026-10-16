import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotSearchResult, BotSummary } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';

/**
 * Bot permissions on invite (bots.md, "Permissions on invite"): the owner sets
 * what a bot asks for; a manager adding it grants a subset through a managed
 * role created for the bot alone, which stays with the bot, is never given to
 * anyone else nor deleted on its own, follows the bot's name, and goes when
 * the bot leaves.
 */

setWorkerId(31);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'owner';

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));
const announceSpaceAccessChange = vi.fn();
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    addUserSpace: vi.fn(),
    removeUserSpace: vi.fn(),
    sendToSpace: vi.fn(),
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
    forceDisconnectUser: vi.fn(),
    announceSpaceAccessChange: (...args: unknown[]) => announceSpaceAccessChange(...args),
    getUserSpaceEntries: () => new Map<string, Set<string>>().entries(),
  },
}));
vi.mock('../ws/events.js', () => ({ checkVoicePermissions: vi.fn() }));
vi.mock('../ws/presence.js', () => ({ applyStoredBotActivity: vi.fn() }));
vi.mock('../utils/profileRelay.js', () => ({ queueProfileUpdateRelay: vi.fn() }));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

const SPACE_ID = 'space-1';
const now = 1_700_000_000_000;
const { SEND_MESSAGES, KICK_MEMBERS, MANAGE_SPACE, VIEW_CHANNEL } = PermissionBits;
const REQUESTED = SEND_MESSAGES | KICK_MEMBERS;

let app: FastifyInstance;

const as = (userId: string) => { currentUserId = userId; };
const addBot = (botId: string, payload: Record<string, unknown> = {}) => app.inject({
  method: 'POST', url: `/api/bots/${botId}/spaces`, payload: { spaceId: SPACE_ID, ...payload },
});
const managedRole = (botId: string) => testDb.select().from(schema.roles)
  .where(and(eq(schema.roles.spaceId, SPACE_ID), eq(schema.roles.managedBotId, botId))).get();
const rolesOf = (userId: string) => testDb.select().from(schema.memberRoles)
  .where(and(eq(schema.memberRoles.spaceId, SPACE_ID), eq(schema.memberRoles.userId, userId)))
  .all().map(r => r.roleId).sort();
const codeOf = (res: { json: () => unknown }) => (res.json() as { code: string }).code;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  announceSpaceAccessChange.mockReset();
  currentUserId = 'owner';

  testDb.insert(schema.users).values([
    { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: now },
    { id: 'manager', username: 'manager', passwordHash: 'x', createdAt: now },
    { id: 'plain', username: 'plain', passwordHash: 'x', createdAt: now },
    {
      id: 'radio-bot', username: 'radio_bot', displayName: 'Radio_bot', passwordHash: '!bot', isBot: 1,
      botOwnerId: 'owner', botRequestedPermissions: permissionsToString(REQUESTED), createdAt: now,
    },
    // A bot of another instance that registered an account here with its proof.
    {
      id: 'far-bot', username: 'far_bot@orbit.example', displayName: 'Far_bot', passwordHash: 'hash', isBot: 1,
      homeInstance: 'orbit.example', homeUserId: 'orbit-far', botRequestedPermissions: permissionsToString(SEND_MESSAGES),
      createdAt: now,
    },
    // A replica of a bot that never registered here: it cannot sign in.
    {
      id: 'stub-bot', username: 'stub_bot@orbit.example', passwordHash: '!federation-replicated', isBot: 1,
      homeInstance: 'orbit.example', homeUserId: 'orbit-stub', createdAt: now,
    },
  ]).run();
  testDb.insert(schema.spaces).values({
    id: SPACE_ID, name: 'Space', ownerId: 'owner', inviteCode: 'code', visibility: 'public', createdAt: now,
  }).run();
  testDb.insert(schema.roles).values([
    { id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', position: 0, permissions: permissionsToString(VIEW_CHANNEL), createdAt: now },
    { id: 'r-manager', spaceId: SPACE_ID, name: 'Managers', position: 2, permissions: permissionsToString(MANAGE_SPACE | SEND_MESSAGES), createdAt: now },
    { id: 'r-member', spaceId: SPACE_ID, name: 'Members', position: 1, permissions: '0', createdAt: now },
  ]).run();
  for (const userId of ['owner', 'manager', 'plain']) {
    testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId, joinedAt: now }).run();
  }
  testDb.insert(schema.memberRoles).values({ spaceId: SPACE_ID, userId: 'manager', roleId: 'r-manager' }).run();

  const { botRoutes } = await import('./bots.js');
  const { spaceRoutes } = await import('./spaces.js');
  app = Fastify({ logger: false });
  await app.register(botRoutes);
  await app.register(spaceRoutes);
  await app.ready();
});

describe('what a bot asks for', () => {
  it('is set by the owner as a permission mask and listed', async () => {
    const value = permissionsToString(SEND_MESSAGES | VIEW_CHANNEL);
    const res = await app.inject({ method: 'PATCH', url: '/api/bots/radio-bot', payload: { requestedPermissions: value } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bot: BotSummary }).bot.requestedPermissions).toBe(value);

    for (const bad of ['0x10', '-1', ' 4', (1n << 40n).toString(), 16]) {
      const refused = await app.inject({ method: 'PATCH', url: '/api/bots/radio-bot', payload: { requestedPermissions: bad } });
      expect(refused.statusCode).toBe(400);
      expect(codeOf(refused)).toBe('bot_permissions_invalid');
    }
    const cleared = await app.inject({ method: 'PATCH', url: '/api/bots/radio-bot', payload: { requestedPermissions: '0' } });
    expect((cleared.json() as { bot: BotSummary }).bot.requestedPermissions).toBe('0');
  });
});

describe('adding a bot to a space', () => {
  it('the owner of the space grants everything asked for, in a role at the bottom named after the bot', async () => {
    const res = await addBot('radio-bot');
    expect(res.statusCode).toBe(200);

    const role = managedRole('radio-bot');
    expect(role?.name).toBe('Radio_bot');
    expect(role?.permissions).toBe(permissionsToString(REQUESTED));
    expect(role?.position).toBe(1);
    expect(rolesOf('radio-bot')).toEqual([role?.id]);
    expect(announceSpaceAccessChange).toHaveBeenCalledWith(SPACE_ID, ['radio-bot']);
  });

  it('a manager grants only what the bot asked for and what they hold themselves', async () => {
    as('manager');
    const notRequested = await addBot('radio-bot', { permissions: permissionsToString(SEND_MESSAGES | VIEW_CHANNEL) });
    expect(notRequested.statusCode).toBe(400);
    expect(codeOf(notRequested)).toBe('bot_permissions_not_requested');

    const unheld = await addBot('radio-bot', { permissions: permissionsToString(REQUESTED) });
    expect(unheld.statusCode).toBe(403);
    expect(codeOf(unheld)).toBe('cannot_grant_unowned_permissions');

    const malformed = await addBot('radio-bot', { permissions: '04' });
    expect(codeOf(malformed)).toBe('permissions_invalid');

    // Omitted: every requested bit the manager holds (not KICK_MEMBERS).
    expect((await addBot('radio-bot')).statusCode).toBe(200);
    expect(managedRole('radio-bot')?.permissions).toBe(permissionsToString(SEND_MESSAGES));
  });

  it('nothing granted: the bot joins without a role', async () => {
    expect((await addBot('radio-bot', { permissions: '0' })).statusCode).toBe(200);
    expect(managedRole('radio-bot')).toBeUndefined();
    expect(rolesOf('radio-bot')).toEqual([]);
  });

  it('a bot of another instance with an account here is found and added; a replica is not', async () => {
    as('manager');
    const search = await app.inject({ method: 'GET', url: '/api/bots/search?q=bot' });
    const names = (search.json() as { bots: BotSearchResult[] }).bots.map(b => b.username);
    expect(names).toContain('far_bot@orbit.example');
    expect(names).toContain('radio_bot');
    expect(names).not.toContain('stub_bot@orbit.example');

    expect((await addBot('far-bot')).statusCode).toBe(200);
    expect(managedRole('far-bot')?.permissions).toBe(permissionsToString(SEND_MESSAGES));
    expect(codeOf(await addBot('stub-bot'))).toBe('bot_not_found');
  });
});

describe('the managed role', () => {
  beforeEach(async () => {
    await addBot('radio-bot');
  });

  it('is never given to anyone else, never taken from its bot and never deleted on its own', async () => {
    const roleId = managedRole('radio-bot')!.id;

    const give = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/members/plain/roles`, payload: { roleId } });
    expect(codeOf(give)).toBe('role_managed_by_bot');
    const take = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/members/radio-bot/roles/${roleId}` });
    expect(codeOf(take)).toBe('role_managed_by_bot');
    const remove = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/roles/${roleId}` });
    expect(codeOf(remove)).toBe('role_managed_by_bot');
    const giveInSet = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/members/plain`, payload: { roleIds: [roleId] } });
    expect(codeOf(giveInSet)).toBe('role_managed_by_bot');

    expect(rolesOf('plain')).toEqual([]);
    expect(rolesOf('radio-bot')).toEqual([roleId]);
  });

  it('stays on its bot whatever role set is saved for it', async () => {
    const roleId = managedRole('radio-bot')!.id;
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/members/radio-bot`, payload: { roleIds: ['r-member'] } });
    expect(res.statusCode).toBe(200);
    expect(rolesOf('radio-bot')).toEqual([roleId, 'r-member'].sort());
  });

  it('can be edited like any role', async () => {
    const roleId = managedRole('radio-bot')!.id;
    const res = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/${roleId}`,
      payload: { name: 'DJ', permissions: permissionsToString(SEND_MESSAGES) },
    });
    expect(res.statusCode).toBe(200);
    expect(managedRole('radio-bot')?.name).toBe('DJ');
  });

  it('follows the bot\'s name, avoiding a name taken in the space', async () => {
    testDb.insert(schema.roles).values({ id: 'r-echo', spaceId: SPACE_ID, name: 'Echo_bot', position: 3, permissions: '0', createdAt: now }).run();
    const res = await app.inject({ method: 'PATCH', url: '/api/bots/radio-bot', payload: { displayName: 'Echo_bot' } });
    expect(res.statusCode).toBe(200);
    expect(managedRole('radio-bot')?.name).toBe('Echo_bot (2)');
    expect(announceSpaceAccessChange).toHaveBeenLastCalledWith(SPACE_ID, []);
  });

  it('goes with its overrides when the bot is taken out of the space', async () => {
    const roleId = managedRole('radio-bot')!.id;
    testDb.insert(schema.channels).values({ id: 'c1', spaceId: SPACE_ID, name: 'general', type: 'text', createdAt: now }).run();
    testDb.insert(schema.channelOverrides).values({ channelId: 'c1', targetType: 'role', targetId: roleId, allow: '0', deny: '0' }).run();

    const res = await app.inject({ method: 'DELETE', url: `/api/bots/radio-bot/spaces/${SPACE_ID}` });
    expect(res.statusCode).toBe(200);
    expect(managedRole('radio-bot')).toBeUndefined();
    expect(testDb.select().from(schema.channelOverrides).all()).toEqual([]);
  });

  it('goes when the bot is banned, and when the bot is deleted', async () => {
    const ban = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/bans`, payload: { userId: 'radio-bot' } });
    expect(ban.statusCode).toBe(200);
    expect(managedRole('radio-bot')).toBeUndefined();

    await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/bans/radio-bot` });
    await addBot('radio-bot');
    expect(managedRole('radio-bot')).toBeDefined();
    const { tombstoneUser } = await import('../utils/userDeletion.js');
    tombstoneUser('radio-bot');
    expect(managedRole('radio-bot')).toBeUndefined();
  });
});
