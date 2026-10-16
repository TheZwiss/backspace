import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EphemeralReply } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

/**
 * Answers only the invoker sees (bots.md, "Answering"): `ephemeral: true`
 * sends text to the invoker's sessions as `interaction_ephemeral`, stores
 * nothing, and counts toward the interaction's answers.
 */

setWorkerId(35);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'bot';

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
const now = Date.now();
let app: FastifyInstance;

const interaction = (id: string, chat: { channelId?: string; dmChannelId?: string }, botId = 'bot') => {
  testDb.insert(schema.interactions).values({
    id, botId, userId: 'alice', channelId: chat.channelId ?? null, dmChannelId: chat.dmChannelId ?? null,
    command: 'purge', options: '{}', createdAt: now, expiresAt: now + 15 * 60 * 1000,
  }).run();
};
const respond = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/interactions/${id}/respond`, payload });
const messageCount = () => testDb.select().from(schema.messages).all().length;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  sendToUser.mockReset();
  currentUserId = 'bot';

  testDb.insert(schema.users).values([
    { id: 'alice', username: 'alice', passwordHash: 'x', createdAt: now },
    { id: 'bot', username: 'mod_bot', passwordHash: '!bot', isBot: 1, createdAt: now },
    { id: 'other-bot', username: 'other_bot', passwordHash: '!bot', isBot: 1, createdAt: now },
  ]).run();
  testDb.insert(schema.spaces).values({ id: SPACE, name: 'Space', ownerId: 'alice', inviteCode: 'a', visibility: 'public', createdAt: now }).run();
  testDb.insert(schema.channels).values({ id: 'c-text', spaceId: SPACE, name: 'general', type: 'text', createdAt: now }).run();
  testDb.insert(schema.dmChannels).values({ id: 'dm1', createdAt: now }).run();
  interaction('i-channel', { channelId: 'c-text' });
  interaction('i-dm', { dmChannelId: 'dm1' });

  const { interactionRoutes } = await import('./interactions.js');
  app = Fastify({ logger: false });
  await app.register(interactionRoutes);
  await app.ready();
});

describe('an answer only the invoker sees', () => {
  it('goes to the invoker alone and is not stored', async () => {
    const res = await respond('i-channel', { content: 'Deleted 5 messages', ephemeral: true });
    expect(res.statusCode).toBe(201);
    const sent = res.json() as EphemeralReply;
    expect(sent).toMatchObject({
      interactionId: 'i-channel', command: 'purge', content: 'Deleted 5 messages', channelId: 'c-text', spaceId: SPACE,
      user: { id: 'bot', username: 'mod_bot' },
    });
    expect(sent.dmChannelId).toBeUndefined();
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(sendToUser).toHaveBeenCalledWith('alice', { type: 'interaction_ephemeral', reply: sent });
    expect(messageCount()).toBe(0);

    const inDm = (await respond('i-dm', { content: 'Only for you', ephemeral: true })).json() as EphemeralReply;
    expect(inDm).toMatchObject({ dmChannelId: 'dm1' });
    expect(inDm.channelId).toBeUndefined();
  });

  it('is text only, within the message length', async () => {
    const cases: Array<[Record<string, unknown>, number, string, unknown]> = [
      [{ content: 'x', attachments: ['a1'], ephemeral: true }, 400, 'validation_failed', { field: 'attachments', reason: 'not allowed in an ephemeral answer' }],
      [{ content: '   ', ephemeral: true }, 400, 'message_empty', undefined],
      [{ ephemeral: true }, 400, 'message_empty', undefined],
      [{ content: 'x'.repeat(4001), ephemeral: true }, 400, 'content_too_long', { max: 4000 }],
      [{ content: 'x', ephemeral: 'yes' }, 400, 'validation_failed', { field: 'ephemeral', reason: 'must be a boolean' }],
    ];
    for (const [payload, status, code, details] of cases) {
      const res = await respond('i-channel', payload);
      const body = res.json() as { code?: string; details?: unknown };
      expect([res.statusCode, body.code, body.details], JSON.stringify(payload)).toEqual([status, code, details]);
    }
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('counts toward the five answers, while a refused one does not', async () => {
    await respond('i-channel', { ephemeral: true });
    for (let i = 0; i < 5; i++) {
      expect((await respond('i-channel', { content: `answer ${i}`, ephemeral: true })).statusCode).toBe(201);
    }
    const sixth = await respond('i-channel', { content: 'one more', ephemeral: true });
    expect(sixth.statusCode).toBe(429);
    expect((sixth.json() as { code?: string }).code).toBe('interaction_responses_exceeded');
  });

  it('answers only the bot that was invoked', async () => {
    currentUserId = 'other-bot';
    expect((await respond('i-channel', { content: 'hi', ephemeral: true })).statusCode).toBe(404);
  });
});
