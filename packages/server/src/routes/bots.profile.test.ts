import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { BotSummary } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signJwt } from '../utils/auth.js';

/**
 * PATCH /api/bots/:id { bio, activity }: the bot's "About" and its stored
 * status. The status is part of the profile (relayed with it) and replaces the
 * bot's live activity at once, but only when the status itself changed.
 */

setWorkerId(30);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    forceDisconnectUser: vi.fn(),
    removeUserSpace: vi.fn(),
    addUserSpace: vi.fn(),
  },
}));
const applyStoredBotActivity = vi.fn();
vi.mock('../ws/presence.js', () => ({
  applyStoredBotActivity: (...args: unknown[]) => applyStoredBotActivity(...args),
}));
const queueProfileUpdateRelay = vi.fn();
vi.mock('../utils/profileRelay.js', () => ({
  queueProfileUpdateRelay: (...args: unknown[]) => queueProfileUpdateRelay(...args),
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

const owner = () => ({ Authorization: `Bearer ${signJwt({ userId: 'owner', username: 'owner' })}` });
const patch = (payload: Record<string, unknown>) => app.inject({
  method: 'PATCH', url: '/api/bots/bot-1', headers: owner(), payload,
});
const stored = () => testDb.select().from(schema.users).where(eq(schema.users.id, 'bot-1')).get()!;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.users).values([
    { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
    { id: 'bot-1', username: 'radio_bot', displayName: 'Radio_bot', passwordHash: '!bot', isBot: 1, botOwnerId: 'owner', createdAt: 1 },
  ]).run();
  applyStoredBotActivity.mockReset();
  queueProfileUpdateRelay.mockReset();
  const { botRoutes } = await import('./bots.js');
  app = Fastify({ logger: false });
  await app.register(botRoutes);
  await app.ready();
});

describe('the "About" of a bot', () => {
  it('is stored trimmed, relayed with the profile and listed', async () => {
    const res = await patch({ bio: '  Plays radio in voice. /play to start.  ' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bot: BotSummary }).bot.bio).toBe('Plays radio in voice. /play to start.');
    expect(stored().bio).toBe('Plays radio in voice. /play to start.');
    expect(queueProfileUpdateRelay).toHaveBeenCalledTimes(1);

    const list = await app.inject({ method: 'GET', url: '/api/bots', headers: owner() });
    expect((list.json() as { bots: BotSummary[] }).bots[0]?.bio).toBe('Plays radio in voice. /play to start.');
  });

  it('is cleared by blank text or null, and refused over the limit', async () => {
    await patch({ bio: 'x' });
    expect((await patch({ bio: '   ' })).statusCode).toBe(200);
    expect(stored().bio).toBeNull();
    await patch({ bio: 'x' });
    expect((await patch({ bio: null })).statusCode).toBe(200);
    expect(stored().bio).toBeNull();

    const res = await patch({ bio: 'a'.repeat(191) });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('bio_too_long');
  });

  it('does not touch the live status', async () => {
    await patch({ bio: 'About me' });
    expect(applyStoredBotActivity).not.toHaveBeenCalled();
  });
});

describe('the stored status of a bot', () => {
  it('is stored, listed and shown at once', async () => {
    const res = await patch({ activity: { type: 'listening', name: '  lofi radio ' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bot: BotSummary }).bot.activity).toEqual({ type: 'listening', name: 'lofi radio' });
    expect(JSON.parse(stored().botActivity ?? 'null')).toEqual({ type: 'listening', name: 'lofi radio' });
    expect(applyStoredBotActivity).toHaveBeenCalledWith('bot-1', { type: 'listening', name: 'lofi radio' });
    expect(queueProfileUpdateRelay).toHaveBeenCalledTimes(1);
  });

  it('is applied again only when it changes', async () => {
    await patch({ activity: { type: 'playing', name: 'chess' } });
    await patch({ activity: { type: 'playing', name: 'chess' } });
    await patch({ displayName: 'Chess_bot' });
    expect(applyStoredBotActivity).toHaveBeenCalledTimes(1);
  });

  it('is cleared by null', async () => {
    await patch({ activity: { type: 'custom', name: 'Type /help' } });
    const res = await patch({ activity: null });
    expect(res.statusCode).toBe(200);
    expect(stored().botActivity).toBeNull();
    expect((res.json() as { bot: BotSummary }).bot.activity).toBeNull();
    expect(applyStoredBotActivity).toHaveBeenLastCalledWith('bot-1', null);
  });

  it('refuses an unknown type, an empty text and a text over 128 characters, and keeps what was stored', async () => {
    await patch({ activity: { type: 'watching', name: 'the logs' } });
    for (const activity of [
      { type: 'streaming', name: 'x' },
      { type: 'playing', name: '   ' },
      { type: 'playing', name: 'a'.repeat(129) },
      { type: 'playing' },
      'playing',
    ]) {
      const res = await patch({ activity });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { code: string }).code).toBe('bot_activity_invalid');
    }
    expect(JSON.parse(stored().botActivity ?? 'null')).toEqual({ type: 'watching', name: 'the logs' });
    expect(applyStoredBotActivity).toHaveBeenCalledTimes(1);
  });
});
