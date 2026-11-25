import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotCommandOption, BotInteraction } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';

/**
 * Typed slash command options (bots.md, "Option types"): limits checked when a
 * bot registers its commands, values checked and coerced when a person invokes
 * one, and the users, channels and roles they name handed to the bot in
 * `resolved`.
 */

setWorkerId(32);
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
const OTHER_SPACE = 's2';
const now = 1_700_000_000_000;
let app: FastifyInstance;

const register = (options: unknown[]) => app.inject({
  method: 'PUT', url: '/api/bots/@me/commands',
  payload: { commands: [{ name: 'test', description: 'Test', options }] },
});
const define = (options: BotCommandOption[]) => {
  testDb.insert(schema.botCommands).values({
    id: 'cmd', botId: 'bot', name: 'test', description: 'Test', options: JSON.stringify(options), updatedAt: now,
  }).run();
};
const invoke = (options: Record<string, unknown>, chat: Record<string, string> = { channelId: 'c-text' }) => app.inject({
  method: 'POST', url: '/api/interactions', payload: { botId: 'bot', command: 'test', options, ...chat },
});
const reasonOf = (res: { json: () => unknown }) => (res.json() as { details?: { reason?: string } }).details?.reason;
const lastInteraction = (): BotInteraction =>
  (sendToUser.mock.calls.at(-1)?.[1] as { interaction: BotInteraction }).interaction;

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
    { id: 'stranger', username: 'stranger', passwordHash: 'x', createdAt: now },
    { id: 'bot', username: 'test_bot', passwordHash: '!bot', isBot: 1, createdAt: now },
  ]).run();
  testDb.insert(schema.spaces).values([
    { id: SPACE, name: 'Space', ownerId: 'alice', inviteCode: 'a', visibility: 'public', createdAt: now },
    { id: OTHER_SPACE, name: 'Other', ownerId: 'stranger', inviteCode: 'b', visibility: 'public', createdAt: now },
  ]).run();
  const viewSend = permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES);
  testDb.insert(schema.roles).values([
    { id: SPACE, spaceId: SPACE, name: '@everyone', position: 0, permissions: viewSend, createdAt: now },
    { id: 'r-mods', spaceId: SPACE, name: 'Mods', position: 1, permissions: '0', createdAt: now },
    { id: OTHER_SPACE, spaceId: OTHER_SPACE, name: '@everyone', position: 0, permissions: viewSend, createdAt: now },
  ]).run();
  for (const userId of ['alice', 'bob', 'bot']) {
    testDb.insert(schema.spaceMembers).values({ spaceId: SPACE, userId, joinedAt: now }).run();
  }
  testDb.insert(schema.spaceMembers).values({ spaceId: OTHER_SPACE, userId: 'stranger', joinedAt: now }).run();
  testDb.insert(schema.channels).values([
    { id: 'c-text', spaceId: SPACE, name: 'general', type: 'text', createdAt: now },
    { id: 'c-voice', spaceId: SPACE, name: 'lounge', type: 'voice', createdAt: now },
    { id: 'c-hidden', spaceId: SPACE, name: 'staff', type: 'text', createdAt: now },
    { id: 'c-elsewhere', spaceId: OTHER_SPACE, name: 'away', type: 'text', createdAt: now },
  ]).run();
  // alice's view of #staff is taken away; she owns the space, so "plain" bob is the viewer used below.
  testDb.insert(schema.channelOverrides).values({
    channelId: 'c-hidden', targetType: 'role', targetId: SPACE, allow: '0', deny: permissionsToString(PermissionBits.VIEW_CHANNEL),
  }).run();

  const { botCommandRoutes } = await import('./botCommands.js');
  const { interactionRoutes } = await import('./interactions.js');
  app = Fastify({ logger: false });
  await app.register(botCommandRoutes);
  await app.register(interactionRoutes);
  await app.ready();
});

describe('registering typed options', () => {
  beforeEach(() => { currentUserId = 'bot'; });

  it('takes user, channel and role options and the limits that fit each type', async () => {
    const res = await register([
      { name: 'who', description: 'Who', type: 'user', required: true },
      { name: 'where', description: 'Where', type: 'channel', channelTypes: ['voice'] },
      { name: 'group', description: 'Group', type: 'role' },
      { name: 'count', description: 'Count', type: 'integer', minValue: 1, maxValue: 10 },
      { name: 'ratio', description: 'Ratio', type: 'number', minValue: 0, maxValue: 1.5 },
      { name: 'note', description: 'Note', type: 'string', minLength: 3, maxLength: 20 },
    ]);
    expect(res.statusCode).toBe(200);
    const options = (res.json() as { commands: Array<{ options: BotCommandOption[] }> }).commands[0]?.options ?? [];
    expect(options.find(o => o.name === 'where')?.channelTypes).toEqual(['voice']);
    expect(options.find(o => o.name === 'count')).toMatchObject({ minValue: 1, maxValue: 10 });
    expect(options.find(o => o.name === 'note')).toMatchObject({ minLength: 3, maxLength: 20 });
  });

  it('refuses a limit on the wrong type, crossed limits, bad channel types and choices on an id option', async () => {
    const cases: Array<[unknown, string]> = [
      [{ name: 'x', description: 'X', type: 'string', minValue: 1 }, 'options[0].minValue'],
      [{ name: 'x', description: 'X', type: 'integer', minLength: 1 }, 'options[0].minLength'],
      [{ name: 'x', description: 'X', type: 'integer', minValue: 5, maxValue: 1 }, 'options[0].minValue'],
      [{ name: 'x', description: 'X', type: 'integer', minValue: 1.5 }, 'options[0].minValue'],
      [{ name: 'x', description: 'X', type: 'string', maxLength: 2001 }, 'options[0].maxLength'],
      [{ name: 'x', description: 'X', type: 'string', maxLength: 0 }, 'options[0].maxLength'],
      [{ name: 'x', description: 'X', type: 'channel', channelTypes: [] }, 'options[0].channelTypes'],
      [{ name: 'x', description: 'X', type: 'channel', channelTypes: ['category'] }, 'options[0].channelTypes'],
      [{ name: 'x', description: 'X', type: 'user', channelTypes: ['text'] }, 'options[0].channelTypes'],
      [{ name: 'x', description: 'X', type: 'user', choices: [{ name: 'a', value: 'a' }] }, 'options[0].choices'],
      [{ name: 'x', description: 'X', type: 'integer', minValue: 5, choices: [{ name: 'a', value: 1 }] }, 'options[0].choices[0].value'],
      [{ name: 'x', description: 'X', type: 'string', maxLength: 2, choices: [{ name: 'a', value: 'abc' }] }, 'options[0].choices[0].value'],
      [{ name: 'x', description: 'X', type: 'string', strictChoices: true }, 'options[0].strictChoices'],
    ];
    for (const [option, field] of cases) {
      const res = await register([option]);
      expect(res.statusCode).toBe(400);
      expect((res.json() as { details: { field: string } }).details.field).toBe(`commands[0].${field}`);
    }
  });
});

describe('choices', () => {
  it('are suggestions: any value of the type within the limits goes, unless the bot made them strict', async () => {
    define([
      { name: 'level', description: 'L', type: 'integer', required: false, minValue: 0, maxValue: 100, choices: [{ name: 'low', value: 20 }] },
      { name: 'mode', description: 'M', type: 'string', required: false, strictChoices: true, choices: [{ name: 'Shuffle', value: 'shuffle' }] },
    ]);
    expect((await invoke({ level: 34 })).statusCode).toBe(201);
    expect(lastInteraction().options).toEqual({ level: 34 });
    expect(reasonOf(await invoke({ level: 101 }))).toBe('must be at most 100');
    expect(reasonOf(await invoke({ mode: 'repeat' }))).toBe('must be one of the listed choices');
    expect((await invoke({ mode: 'shuffle' })).statusCode).toBe(201);
  });
});

describe('invoking with typed values', () => {
  it('checks number ranges and string lengths', async () => {
    define([
      { name: 'count', description: 'C', type: 'integer', required: false, minValue: 1, maxValue: 10 },
      { name: 'note', description: 'N', type: 'string', required: false, minLength: 3, maxLength: 5 },
    ]);
    expect(reasonOf(await invoke({ count: 0 }))).toBe('must be at least 1');
    expect(reasonOf(await invoke({ count: 11 }))).toBe('must be at most 10');
    expect(reasonOf(await invoke({ note: 'ab' }))).toBe('must be a string of 3 to 5 characters');
    expect(reasonOf(await invoke({ note: 'abcdef' }))).toBe('must be a string of 3 to 5 characters');
    expect((await invoke({ count: 10, note: 'abc' })).statusCode).toBe(201);
    expect(lastInteraction().options).toEqual({ count: 10, note: 'abc' });
    expect(lastInteraction().resolved).toBeUndefined();
  });

  it('hands the bot the user, channel and role named, in resolved', async () => {
    define([
      { name: 'who', description: 'W', type: 'user', required: true },
      { name: 'where', description: 'W', type: 'channel', required: false, channelTypes: ['voice'] },
      { name: 'group', description: 'G', type: 'role', required: false },
    ]);
    const res = await invoke({ who: 'bob', where: 'c-voice', group: 'r-mods' });
    expect(res.statusCode).toBe(201);
    const interaction = lastInteraction();
    expect(interaction.options).toEqual({ who: 'bob', where: 'c-voice', group: 'r-mods' });
    expect(interaction.resolved?.users?.bob?.username).toBe('bob');
    expect(interaction.resolved?.channels?.['c-voice']).toEqual({ id: 'c-voice', spaceId: SPACE, name: 'lounge', type: 'voice' });
    expect(interaction.resolved?.roles?.['r-mods']?.name).toBe('Mods');
    expect(interaction.resolved?.roles?.['r-mods']?.permissions).toBeUndefined();
  });

  it('refuses ids the chat does not know, and channels of another type or out of the invoker\'s sight', async () => {
    define([
      { name: 'who', description: 'W', type: 'user', required: false },
      { name: 'where', description: 'W', type: 'channel', required: false, channelTypes: ['text'] },
      { name: 'group', description: 'G', type: 'role', required: false },
    ]);
    expect(reasonOf(await invoke({ who: 'stranger' }))).toBe('must be a member of this chat');
    expect(reasonOf(await invoke({ who: 'nobody' }))).toBe('must be a member of this chat');
    expect(reasonOf(await invoke({ where: 'c-voice' }))).toBe('must be a channel of type text');
    expect(reasonOf(await invoke({ where: 'c-elsewhere' }))).toBe('must be a channel of this space');
    expect(reasonOf(await invoke({ group: OTHER_SPACE }))).toBe('must be a role of this space');
    expect(reasonOf(await invoke({ who: 42 }))).toBe('must be the id of a user');

    currentUserId = 'bob';
    expect(reasonOf(await invoke({ where: 'c-hidden' }))).toBe('must be a channel of this space');
  });

  it('a DM has no channels or roles to name, but its members can be named', async () => {
    testDb.insert(schema.dmChannels).values({ id: 'dm1', createdAt: now }).run();
    for (const userId of ['alice', 'bob', 'bot']) testDb.insert(schema.dmMembers).values({ dmChannelId: 'dm1', userId }).run();
    define([
      { name: 'who', description: 'W', type: 'user', required: false },
      { name: 'where', description: 'W', type: 'channel', required: false },
    ]);
    expect(reasonOf(await invoke({ where: 'c-text' }, { dmChannelId: 'dm1' }))).toBe('a channel can only be chosen in a space');
    expect((await invoke({ who: 'bob' }, { dmChannelId: 'dm1' })).statusCode).toBe(201);
    expect(lastInteraction().resolved?.users?.bob).toBeDefined();
  });
});
