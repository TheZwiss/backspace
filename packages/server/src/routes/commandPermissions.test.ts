import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotCommand, BotCommandListing, BotCommandOption } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';

/**
 * Permissions a command asks of the people who use it (bots.md, "Required
 * permissions"): registered as a mask or as names, held in the invoking
 * channel; a command or subcommand without them is neither listed nor run,
 * and a command that needs any is hidden in direct messages.
 */

setWorkerId(34);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'alice';

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));
const sendToUser = vi.fn();
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: (...args: unknown[]) => sendToUser(...args),
    hasLiveConnection: () => true,
  },
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

const SPACE = 's1';
const now = 1_700_000_000_000;
const MANAGE = permissionsToString(PermissionBits.MANAGE_MESSAGES);
const KICK = permissionsToString(PermissionBits.KICK_MEMBERS);
let app: FastifyInstance;

const step = (name: string, type: 'subcommand' | 'subcommand_group', options: BotCommandOption[], requiredPermissions?: string): BotCommandOption =>
  ({ name, description: name, type, required: false, options, ...(requiredPermissions ? { requiredPermissions } : {}) });

const register = (command: Record<string, unknown>) => app.inject({
  method: 'PUT', url: '/api/bots/@me/commands',
  payload: { commands: [{ name: 'purge', description: 'Purge', ...command }] },
});
const define = (name: string, options: BotCommandOption[], requiredPermissions: string | null = null) => {
  testDb.insert(schema.botCommands).values({
    id: `cmd-${name}`, botId: 'bot', name, description: name, options: JSON.stringify(options), requiredPermissions, updatedAt: now,
  }).run();
};
const listed = async (chat = 'channelId=c-text'): Promise<BotCommandListing[]> =>
  ((await app.inject({ method: 'GET', url: `/api/commands?${chat}` })).json() as { commands: BotCommandListing[] }).commands;
const invoke = (body: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/api/interactions', payload: { botId: 'bot', channelId: 'c-text', ...body },
});
const errorOf = (res: { statusCode: number; json: () => unknown }) => {
  const body = res.json() as { error?: string; code?: string; details?: unknown };
  return [res.statusCode, body.details];
};

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  sendToUser.mockReset();
  currentUserId = 'alice';

  testDb.insert(schema.users).values([
    { id: 'alice', username: 'alice', passwordHash: 'x', createdAt: now },
    { id: 'bob', username: 'bob', passwordHash: 'x', createdAt: now },
    { id: 'carol', username: 'carol', passwordHash: 'x', createdAt: now },
    { id: 'bot', username: 'mod_bot', passwordHash: '!bot', isBot: 1, createdAt: now },
  ]).run();
  testDb.insert(schema.spaces).values({ id: SPACE, name: 'Space', ownerId: 'alice', inviteCode: 'a', visibility: 'public', createdAt: now }).run();
  const viewSend = permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES);
  testDb.insert(schema.roles).values([
    { id: SPACE, spaceId: SPACE, name: '@everyone', position: 0, permissions: viewSend, createdAt: now },
    { id: 'r-mods', spaceId: SPACE, name: 'Mods', position: 1, permissions: MANAGE, createdAt: now },
  ]).run();
  for (const userId of ['alice', 'bob', 'carol', 'bot']) {
    testDb.insert(schema.spaceMembers).values({ spaceId: SPACE, userId, joinedAt: now }).run();
  }
  // carol is a moderator everywhere; bob only in #bob-room, through a member override.
  testDb.insert(schema.memberRoles).values({ spaceId: SPACE, userId: 'carol', roleId: 'r-mods' }).run();
  testDb.insert(schema.channels).values([
    { id: 'c-text', spaceId: SPACE, name: 'general', type: 'text', createdAt: now },
    { id: 'c-bob', spaceId: SPACE, name: 'bob-room', type: 'text', createdAt: now },
  ]).run();
  testDb.insert(schema.channelOverrides).values({ channelId: 'c-bob', targetType: 'member', targetId: 'bob', allow: MANAGE, deny: '0' }).run();
  testDb.insert(schema.dmChannels).values({ id: 'dm1', createdAt: now }).run();
  for (const userId of ['carol', 'bot']) testDb.insert(schema.dmMembers).values({ dmChannelId: 'dm1', userId }).run();

  const { botCommandRoutes } = await import('./botCommands.js');
  const { interactionRoutes } = await import('./interactions.js');
  app = Fastify({ logger: false });
  await app.register(botCommandRoutes);
  await app.register(interactionRoutes);
  await app.ready();
});

describe('registering required permissions', () => {
  beforeEach(() => { currentUserId = 'bot'; });

  it('takes a mask or names and stores the mask', async () => {
    const byNames = await register({ requiredPermissions: ['MANAGE_MESSAGES', 'KICK_MEMBERS'] });
    expect(byNames.statusCode).toBe(200);
    const want = permissionsToString(PermissionBits.MANAGE_MESSAGES | PermissionBits.KICK_MEMBERS);
    expect((byNames.json() as { commands: BotCommand[] }).commands[0]?.requiredPermissions).toBe(want);

    const byMask = await register({ requiredPermissions: MANAGE });
    expect((byMask.json() as { commands: BotCommand[] }).commands[0]?.requiredPermissions).toBe(MANAGE);
    // None asked: nothing stored, nothing handed back.
    for (const none of ['0', []]) {
      const res = await register({ requiredPermissions: none });
      expect((res.json() as { commands: BotCommand[] }).commands[0]).not.toHaveProperty('requiredPermissions');
    }
  });

  it('keeps a step\'s permissions with the step', async () => {
    const res = await register({ options: [
      { name: 'recent', description: 'Recent', type: 'subcommand' },
      { name: 'all', description: 'All', type: 'subcommand', requiredPermissions: ['KICK_MEMBERS'] },
    ] });
    expect((res.json() as { commands: BotCommand[] }).commands[0]?.options[1]).toMatchObject({ name: 'all', requiredPermissions: KICK });
  });

  it('refuses unknown names, a bad mask, unknown bits and permissions on a value option', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ requiredPermissions: ['MANAGE_MESSAGES', 'FLY'] }, 'commands[0].requiredPermissions[1]', 'must be a permission name'],
      [{ requiredPermissions: '0x10' }, 'commands[0].requiredPermissions', 'must be a decimal permission mask or a list of permission names'],
      [{ requiredPermissions: String(1n << 60n) }, 'commands[0].requiredPermissions', 'names a permission that does not exist'],
      [{ options: [{ name: 'n', description: 'N', type: 'integer', requiredPermissions: MANAGE }] },
        'commands[0].options[0].requiredPermissions', 'not allowed for a integer option'],
    ];
    for (const [command, field, reason] of cases) {
      const res = await register(command);
      expect(res.statusCode, field).toBe(400);
      expect((res.json() as { details?: unknown }).details).toEqual({ field, reason });
    }
  });
});

describe('who sees and runs a command', () => {
  beforeEach(() => {
    define('purge', [], MANAGE);
    define('ping', []);
    define('music', [
      step('play', 'subcommand', []),
      step('queue', 'subcommand_group', [step('list', 'subcommand', []), step('clear', 'subcommand', [], MANAGE)]),
      step('admin', 'subcommand_group', [step('reset', 'subcommand', [])], KICK),
    ]);
  });

  const names = (commands: BotCommandListing[]) => commands.map((c) => c.name);
  const steps = (commands: BotCommandListing[]) => {
    const music = commands.find((c) => c.name === 'music');
    return music?.options.map((o) => [o.name, ...(o.options ?? []).map((sub) => sub.name)].join(' '));
  };

  it('lists a command and its steps only to those holding their permissions in the channel', async () => {
    currentUserId = 'bob';
    const bobs = await listed();
    expect(names(bobs)).toEqual(['music', 'ping']);
    expect(steps(bobs)).toEqual(['play', 'queue list']);

    currentUserId = 'carol';
    expect(names(await listed())).toEqual(['music', 'ping', 'purge']);
    expect(steps(await listed())).toEqual(['play', 'queue list clear']);

    // The owner holds everything.
    currentUserId = 'alice';
    expect(steps(await listed())).toEqual(['play', 'queue list clear', 'admin reset']);

    // A channel override counts: bob may purge in his own room.
    currentUserId = 'bob';
    expect(names(await listed('channelId=c-bob'))).toEqual(['music', 'ping', 'purge']);
  });

  it('hides a command that needs permissions in a direct message, and the steps that do', async () => {
    currentUserId = 'carol';
    const inDm = await listed('dmChannelId=dm1');
    expect(names(inDm)).toEqual(['music', 'ping']);
    expect(steps(inDm)).toEqual(['play', 'queue list']);
  });

  it('refuses a call without the permissions, naming the missing ones', async () => {
    currentUserId = 'bob';
    expect(errorOf(await invoke({ command: 'purge' }))).toEqual([403, { permission: 'MANAGE_MESSAGES' }]);
    expect(errorOf(await invoke({ command: 'music', subcommand: ['queue', 'clear'] }))).toEqual([403, { permission: 'MANAGE_MESSAGES' }]);
    expect(errorOf(await invoke({ command: 'music', subcommand: ['admin', 'reset'] }))).toEqual([403, { permission: 'KICK_MEMBERS' }]);
    expect(sendToUser).not.toHaveBeenCalled();

    expect((await invoke({ command: 'music', subcommand: ['queue', 'list'] })).statusCode).toBe(201);
    expect((await invoke({ command: 'purge', channelId: 'c-bob' })).statusCode).toBe(201);
    currentUserId = 'carol';
    expect((await invoke({ command: 'music', subcommand: ['queue', 'clear'] })).statusCode).toBe(201);
    expect(errorOf(await invoke({ command: 'purge', channelId: undefined, dmChannelId: 'dm1' }))).toEqual([403, { permission: 'MANAGE_MESSAGES' }]);
    expect((await invoke({ command: 'ping', channelId: undefined, dmChannelId: 'dm1' })).statusCode).toBe(201);
  });
});
