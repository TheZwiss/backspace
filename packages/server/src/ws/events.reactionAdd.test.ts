import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@backspace/shared/src/permissions.js';

setWorkerId(1);

/**
 * #393: the same user adding the same emoji to the same message twice stores
 * one reaction. The second `reaction_add` inserts nothing, announces nothing
 * and, on a DM message, queues no relay.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

const sendToChannel = vi.fn();
const sendToDmMembers = vi.fn();
vi.mock('./handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToChannel: (...args: unknown[]) => sendToChannel(...args),
    sendToDmMembers: (...args: unknown[]) => sendToDmMembers(...args),
    getAllOnlineUserIds: () => [],
  },
}));

const queueOutboxEvent = vi.fn();
const appendMutationLog = vi.fn();
vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    queueOutboxEvent: (...args: unknown[]) => queueOutboxEvent(...args),
    appendMutationLog: (...args: unknown[]) => appendMutationLog(...args),
  };
});

const NOW = 1_700_000_000_000;

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(id: string): void {
  testDb.insert(schema.users).values({
    id, username: id, displayName: null, passwordHash: 'x', status: 'offline',
    isAdmin: 0, isDeleted: 0, discoverable: 1, homeInstance: null, homeUserId: null, createdAt: NOW,
  }).run();
}

function seedSpaceMessage(): void {
  testDb.insert(schema.spaces).values({
    id: 'space1', name: 'space1', ownerId: 'alice', inviteCode: 'invite-space1', visibility: 'private', createdAt: NOW,
  }).run();
  testDb.insert(schema.roles).values({
    id: 'space1', spaceId: 'space1', name: '@everyone',
    permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS), createdAt: NOW,
  }).run();
  testDb.insert(schema.spaceMembers).values([
    { spaceId: 'space1', userId: 'alice', joinedAt: NOW },
    { spaceId: 'space1', userId: 'bob', joinedAt: NOW },
  ]).run();
  testDb.insert(schema.channels).values({
    id: 'chan1', spaceId: 'space1', name: 'chan1', type: 'text', position: 0, categoryId: null, createdAt: NOW,
  }).run();
  testDb.insert(schema.messages).values({
    id: 'msg1', channelId: 'chan1', userId: 'alice', content: 'hello', createdAt: NOW,
  }).run();
}

function seedDmMessage(): void {
  testDb.insert(schema.dmChannels).values({ id: 'dm1', ownerId: 'alice', federatedId: null, createdAt: NOW }).run();
  testDb.insert(schema.dmMembers).values([
    { dmChannelId: 'dm1', userId: 'alice', closed: 0 },
    { dmChannelId: 'dm1', userId: 'bob', closed: 0 },
  ]).run();
  testDb.insert(schema.dmMessages).values({
    id: 'dmmsg1', dmChannelId: 'dm1', userId: 'alice', type: 'user', content: 'hi', createdAt: NOW,
  }).run();
}

function countRows(table: 'reactions' | 'dm_reactions', column: 'message_id' | 'dm_message_id', messageId: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(messageId) as { n: number }).n;
}

function reactionAddedEvents(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map(call => call.at(-1)).filter(e => (e as { type?: string }).type === 'reaction_added');
}

describe('WS reaction_add repeated by the same user', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    sendToChannel.mockReset();
    sendToDmMembers.mockReset();
    queueOutboxEvent.mockReset();
    appendMutationLog.mockReset();
    seedUser('alice');
    seedUser('bob');
  });

  it('stores and announces one reaction on a space message', async () => {
    seedSpaceMessage();
    const { handleClientEvent } = await import('./events.js');
    const send = (userId: string, emoji: string): void =>
      handleClientEvent({ type: 'reaction_add', messageId: 'msg1', emoji }, userId, userId, {} as WebSocket, false);

    send('bob', '👍');
    send('bob', '👍');

    expect(countRows('reactions', 'message_id', 'msg1')).toBe(1);
    expect(reactionAddedEvents(sendToChannel)).toHaveLength(1);

    // Another emoji, and the same emoji by another user, are separate reactions.
    send('bob', '🎉');
    send('alice', '👍');
    expect(countRows('reactions', 'message_id', 'msg1')).toBe(3);
    expect(reactionAddedEvents(sendToChannel)).toHaveLength(3);
  });

  it('stores, announces and relays one reaction on a DM message', async () => {
    seedDmMessage();
    const { handleClientEvent } = await import('./events.js');
    const send = (userId: string, emoji: string): void =>
      handleClientEvent({ type: 'reaction_add', messageId: 'dmmsg1', emoji }, userId, userId, {} as WebSocket, false);

    send('bob', '👍');
    send('bob', '👍');

    expect(countRows('dm_reactions', 'dm_message_id', 'dmmsg1')).toBe(1);
    expect(reactionAddedEvents(sendToDmMembers)).toHaveLength(1);
    expect(appendMutationLog).toHaveBeenCalledTimes(1);
    expect(queueOutboxEvent).toHaveBeenCalledTimes(1);

    send('alice', '👍');
    expect(countRows('dm_reactions', 'dm_message_id', 'dmmsg1')).toBe(2);
    expect(queueOutboxEvent).toHaveBeenCalledTimes(2);
  });

  it('adds the reaction again after it was removed', async () => {
    seedDmMessage();
    const { handleClientEvent } = await import('./events.js');
    const send = (type: 'reaction_add' | 'reaction_remove'): void =>
      handleClientEvent({ type, messageId: 'dmmsg1', emoji: '👍' }, 'bob', 'bob', {} as WebSocket, false);

    send('reaction_add');
    send('reaction_remove');
    send('reaction_add');

    expect(countRows('dm_reactions', 'dm_message_id', 'dmmsg1')).toBe(1);
    expect(reactionAddedEvents(sendToDmMembers)).toHaveLength(2);
  });
});
