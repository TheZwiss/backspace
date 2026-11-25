import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BotCommand, BotCommandOption, BotInteraction } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';

/**
 * Subcommands and groups (bots.md, "Subcommands"): the shape a bot may
 * register, and the path a person's invocation must name, with the options of
 * the subcommand it names checked as a command's own are.
 */

setWorkerId(33);
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
let app: FastifyInstance;

const value = (name: string, type: BotCommandOption['type'], required = false): BotCommandOption =>
  ({ name, description: name, type, required });
const subcommand = (name: string, options: BotCommandOption[] = []): BotCommandOption =>
  ({ name, description: name, type: 'subcommand', required: false, options });
const group = (name: string, options: BotCommandOption[]): BotCommandOption =>
  ({ name, description: name, type: 'subcommand_group', required: false, options });

/** `/music play query`, `/music queue add query [who]`, `/music queue list`. */
const MUSIC: BotCommandOption[] = [
  subcommand('play', [value('query', 'string', true)]),
  group('queue', [subcommand('add', [value('query', 'string', true), value('who', 'user')]), subcommand('list')]),
];

const register = (options: unknown[]) => app.inject({
  method: 'PUT', url: '/api/bots/@me/commands',
  payload: { commands: [{ name: 'music', description: 'Music', options }] },
});
const define = (name: string, options: BotCommandOption[]) => {
  testDb.insert(schema.botCommands).values({
    id: `cmd-${name}`, botId: 'bot', name, description: name, options: JSON.stringify(options), updatedAt: now,
  }).run();
};
const invoke = (body: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/api/interactions', payload: { botId: 'bot', command: 'music', channelId: 'c-text', ...body },
});
const problemOf = (res: { json: () => unknown }) => (res.json() as { details?: { field?: string; reason?: string } }).details;
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
    { id: 'bot', username: 'music_bot', passwordHash: '!bot', isBot: 1, createdAt: now },
  ]).run();
  testDb.insert(schema.spaces).values({ id: SPACE, name: 'Space', ownerId: 'alice', inviteCode: 'a', visibility: 'public', createdAt: now }).run();
  const viewSend = permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES);
  testDb.insert(schema.roles).values({ id: SPACE, spaceId: SPACE, name: '@everyone', position: 0, permissions: viewSend, createdAt: now }).run();
  for (const userId of ['alice', 'bob', 'bot']) {
    testDb.insert(schema.spaceMembers).values({ spaceId: SPACE, userId, joinedAt: now }).run();
  }
  testDb.insert(schema.channels).values({ id: 'c-text', spaceId: SPACE, name: 'general', type: 'text', createdAt: now }).run();

  const { botCommandRoutes } = await import('./botCommands.js');
  const { interactionRoutes } = await import('./interactions.js');
  app = Fastify({ logger: false });
  await app.register(botCommandRoutes);
  await app.register(interactionRoutes);
  await app.ready();
});

describe('registering subcommands', () => {
  beforeEach(() => { currentUserId = 'bot'; });

  it('stores subcommands and groups with their options, required left false', async () => {
    const res = await register([
      { name: 'play', description: 'Play', type: 'subcommand', options: [{ name: 'query', description: 'Q', type: 'string', required: true }] },
      { name: 'queue', description: 'Queue', type: 'subcommand_group', options: [
        { name: 'add', description: 'Add', type: 'subcommand', options: [{ name: 'query', description: 'Q', type: 'string', required: true }] },
        { name: 'list', description: 'List', type: 'subcommand' },
      ] },
    ]);
    expect(res.statusCode).toBe(200);
    const [music] = (res.json() as { commands: BotCommand[] }).commands;
    expect(music?.options).toEqual([
      { name: 'play', description: 'Play', type: 'subcommand', required: false, options: [{ name: 'query', description: 'Q', type: 'string', required: true }] },
      { name: 'queue', description: 'Queue', type: 'subcommand_group', required: false, options: [
        { name: 'add', description: 'Add', type: 'subcommand', required: false, options: [{ name: 'query', description: 'Q', type: 'string', required: true }] },
        { name: 'list', description: 'List', type: 'subcommand', required: false, options: [] },
      ] },
    ]);
  });

  it('keeps steps and values apart and a path at two words', async () => {
    const cases: Array<[unknown[], string, string]> = [
      // Values beside subcommands.
      [[{ name: 'play', description: 'P', type: 'subcommand' }, { name: 'loud', description: 'L', type: 'boolean' }],
        'commands[0].options[1].type', 'subcommands and groups cannot sit beside value options'],
      // A value in a group.
      [[{ name: 'queue', description: 'Q', type: 'subcommand_group', options: [{ name: 'loud', description: 'L', type: 'boolean' }] }],
        'commands[0].options[0].options[0].type', 'a group holds subcommands only'],
      // A group in a group: a third word.
      [[{ name: 'queue', description: 'Q', type: 'subcommand_group', options: [{ name: 'deep', description: 'D', type: 'subcommand_group', options: [] }] }],
        'commands[0].options[0].options[0].type', 'a group holds subcommands only'],
      // A subcommand in a subcommand.
      [[{ name: 'play', description: 'P', type: 'subcommand', options: [{ name: 'now', description: 'N', type: 'subcommand' }] }],
        'commands[0].options[0].options[0].type', 'a subcommand holds value options only'],
      // An empty group.
      [[{ name: 'queue', description: 'Q', type: 'subcommand_group' }], 'commands[0].options[0].options', 'must hold 1 to 25 subcommands'],
      // What only a value has.
      [[{ name: 'play', description: 'P', type: 'subcommand', required: true }], 'commands[0].options[0].required', 'not allowed for a subcommand'],
      [[{ name: 'play', description: 'P', type: 'subcommand', choices: [{ name: 'a', value: 'a' }] }], 'commands[0].options[0].choices', 'not allowed for a subcommand'],
      // Options on a value.
      [[{ name: 'loud', description: 'L', type: 'boolean', options: [] }], 'commands[0].options[0].options', 'not allowed for a boolean option'],
    ];
    for (const [options, field, reason] of cases) {
      const res = await register(options);
      expect(res.statusCode, field).toBe(400);
      expect(problemOf(res)).toEqual({ field, reason });
    }
  });

  it('counts subcommands and values separately', async () => {
    const many = (n: number, type: string) => Array.from({ length: n }, (_, i) => ({ name: `x${i}`, description: 'X', type }));
    expect((await register(many(25, 'subcommand'))).statusCode).toBe(200);
    expect(problemOf(await register(many(26, 'subcommand')))).toEqual({ field: 'commands[0].options', reason: 'at most 25 subcommands and groups' });
    expect((await register([{ name: 'play', description: 'P', type: 'subcommand', options: many(10, 'string') }])).statusCode).toBe(200);
    expect(problemOf(await register([{ name: 'play', description: 'P', type: 'subcommand', options: many(11, 'string') }])))
      .toEqual({ field: 'commands[0].options[0].options', reason: 'at most 10 options' });
  });
});

describe('invoking a subcommand', () => {
  beforeEach(() => { define('music', MUSIC); });

  it('hands the bot the path and the subcommand\'s options', async () => {
    expect((await invoke({ subcommand: ['play'], options: { query: 'song' } })).statusCode).toBe(201);
    expect(lastInteraction()).toMatchObject({ command: 'music', subcommand: ['play'], options: { query: 'song' } });

    expect((await invoke({ subcommand: ['queue', 'add'], options: { query: 'song', who: 'bob' } })).statusCode).toBe(201);
    const added = lastInteraction();
    expect(added).toMatchObject({ subcommand: ['queue', 'add'], options: { query: 'song', who: 'bob' } });
    expect(Object.keys(added.resolved?.users ?? {})).toEqual(['bob']);

    expect((await invoke({ subcommand: ['queue', 'list'] })).statusCode).toBe(201);
    expect(lastInteraction()).toMatchObject({ subcommand: ['queue', 'list'], options: {} });
  });

  it('checks the options against the subcommand named', async () => {
    expect(problemOf(await invoke({ subcommand: ['play'] }))).toEqual({ field: 'options.query', reason: 'is required' });
    expect(problemOf(await invoke({ subcommand: ['queue', 'list'], options: { query: 'song' } })))
      .toEqual({ field: 'options.query', reason: 'is not an option of this command' });
  });

  it('refuses a missing, partial or unknown path', async () => {
    const cases: Array<[unknown, string]> = [
      [undefined, 'is required: one of play, queue'],
      [[], 'is required: one of play, queue'],
      [['queue'], 'queue needs one of add, list'],
      [['queue', 'remove'], 'queue needs one of add, list'],
      [['play', 'now'], 'play is a subcommand, not a group'],
      [['stop'], 'must start with one of play, queue'],
      ['play', 'must be a list of one or two names'],
      [['queue', 'add', 'more'], 'must be a list of one or two names'],
    ];
    for (const [subcommandPath, reason] of cases) {
      const res = await invoke({ subcommand: subcommandPath, options: { query: 'song' } });
      expect(res.statusCode, String(subcommandPath)).toBe(400);
      expect(problemOf(res)).toEqual({ field: 'subcommand', reason });
    }
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('refuses a path for a command without subcommands, and leaves such a command as it was', async () => {
    define('ping', [value('loud', 'boolean')]);
    const ping = (body: Record<string, unknown>) => invoke({ command: 'ping', ...body });
    expect(problemOf(await ping({ subcommand: ['now'] }))).toEqual({ field: 'subcommand', reason: 'this command has no subcommands' });
    expect((await ping({ options: { loud: true } })).statusCode).toBe(201);
    expect(lastInteraction().subcommand).toBeUndefined();
  });
});
