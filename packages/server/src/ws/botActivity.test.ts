import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import {
  botActivityAsLive,
  normalizeBotActivity,
  parseStoredBotActivity,
  serializeBotActivity,
} from '../utils/botActivity.js';

setWorkerId(2);

/**
 * A bot's stored status (bots.md, "About and status"): the helpers that read
 * and write it, the seed on a bot socket's auth, and the live replacement when
 * the owner changes it. The auth path itself is covered in the e2e suite.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));
const queuePresenceRelay = vi.fn();
vi.mock('../utils/federationPresence.js', () => ({
  queuePresenceRelay: (...args: unknown[]) => queuePresenceRelay(...args),
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

const socket = () => ({ readyState: 1, send: vi.fn() }) as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
const sentEvents = (ws: { send: ReturnType<typeof vi.fn> }) =>
  ws.send.mock.calls.map(([raw]) => JSON.parse(raw as string) as { type: string; activities?: unknown });

const botRow = (overrides: Partial<{ isBot: number; showActivity: number; botActivity: string | null }> = {}) => ({
  id: 'bot-1',
  isBot: 1,
  showActivity: 1,
  botActivity: JSON.stringify({ type: 'playing', name: 'chess' }),
  ...overrides,
});

beforeEach(() => {
  // connectionManager is a module singleton: a fresh copy per test.
  vi.resetModules();
  queuePresenceRelay.mockReset();
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  testDb.insert(schema.users).values({
    id: 'bot-1', username: 'chess_bot', passwordHash: '!bot', isBot: 1, createdAt: 1,
  }).run();
});

describe('the stored status helpers', () => {
  it('normalize trims and refuses anything malformed', () => {
    expect(normalizeBotActivity({ type: 'custom', name: '  /help  ', extra: 1 })).toEqual({ type: 'custom', name: '/help' });
    expect(normalizeBotActivity({ type: 'streaming', name: 'x' })).toBeNull();
    expect(normalizeBotActivity({ type: 'playing', name: '  ' })).toBeNull();
    expect(normalizeBotActivity({ type: 'playing', name: 'a'.repeat(129) })).toBeNull();
    expect(normalizeBotActivity({ type: 'playing', name: 'a'.repeat(128) })).not.toBeNull();
    expect(normalizeBotActivity([{ type: 'playing', name: 'x' }])).toBeNull();
    expect(normalizeBotActivity(null)).toBeNull();
  });

  it('round-trip through the column, and a broken column reads as none', () => {
    const activity = { type: 'watching' as const, name: 'the logs' };
    expect(parseStoredBotActivity(serializeBotActivity(activity))).toEqual(activity);
    expect(serializeBotActivity(null)).toBeNull();
    expect(parseStoredBotActivity(null)).toBeNull();
    expect(parseStoredBotActivity('{not json')).toBeNull();
    expect(parseStoredBotActivity('{"type":"streaming","name":"x"}')).toBeNull();
    expect(botActivityAsLive(activity)).toEqual([activity]);
    expect(botActivityAsLive(null)).toEqual([]);
  });
});

describe('seedStoredBotActivity', () => {
  it('makes the stored status the live activity of a bot with none', async () => {
    const { connectionManager, seedStoredBotActivity } = await import('./handler.js');
    expect(seedStoredBotActivity(botRow())).toEqual([{ type: 'playing', name: 'chess' }]);
    expect(connectionManager.getUserActivities('bot-1')).toEqual([{ type: 'playing', name: 'chess' }]);
  });

  it('keeps an activity another session of the bot already reported', async () => {
    const { connectionManager, seedStoredBotActivity } = await import('./handler.js');
    connectionManager.setUserActivities('bot-1', [{ type: 'listening', name: 'track 7' }]);
    expect(seedStoredBotActivity(botRow())).toBeNull();
    expect(connectionManager.getUserActivities('bot-1')).toEqual([{ type: 'listening', name: 'track 7' }]);
  });

  it('seeds nothing for a person, a bot that hides activities, or a bot without a status', async () => {
    const { connectionManager, seedStoredBotActivity } = await import('./handler.js');
    expect(seedStoredBotActivity(botRow({ isBot: 0 }))).toBeNull();
    expect(seedStoredBotActivity(botRow({ showActivity: 0 }))).toBeNull();
    expect(seedStoredBotActivity(botRow({ botActivity: null }))).toBeNull();
    expect(connectionManager.getUserActivities('bot-1')).toEqual([]);
  });
});

describe('applyStoredBotActivity', () => {
  it('replaces the live activity of a connected bot, even one its code set, and relays it', async () => {
    const { connectionManager } = await import('./handler.js');
    const { applyStoredBotActivity } = await import('./presence.js');
    const ws = socket();
    connectionManager.addConnection('bot-1', ws);
    connectionManager.setUserStatus('bot-1', 'online');
    connectionManager.setUserActivities('bot-1', [{ type: 'listening', name: 'track 7' }]);

    applyStoredBotActivity('bot-1', { type: 'custom', name: 'Type /help' });

    expect(connectionManager.getUserActivities('bot-1')).toEqual([{ type: 'custom', name: 'Type /help' }]);
    const update = sentEvents(ws).find(e => e.type === 'presence_update');
    expect(update?.activities).toEqual([{ type: 'custom', name: 'Type /help' }]);
    await vi.waitFor(() => expect(queuePresenceRelay).toHaveBeenCalledWith('bot-1', 'online', [{ type: 'custom', name: 'Type /help' }]));
  });

  it('clears it with null', async () => {
    const { connectionManager } = await import('./handler.js');
    const { applyStoredBotActivity } = await import('./presence.js');
    connectionManager.addConnection('bot-1', socket());
    connectionManager.setUserActivities('bot-1', [{ type: 'playing', name: 'chess' }]);

    applyStoredBotActivity('bot-1', null);

    expect(connectionManager.getUserActivities('bot-1')).toEqual([]);
  });

  it('does nothing for an offline bot or one that hides activities', async () => {
    const { connectionManager } = await import('./handler.js');
    const { applyStoredBotActivity } = await import('./presence.js');

    applyStoredBotActivity('bot-1', { type: 'playing', name: 'chess' });
    expect(connectionManager.getUserActivities('bot-1')).toEqual([]);

    connectionManager.addConnection('bot-1', socket());
    connectionManager.setUserShowActivity('bot-1', false);
    applyStoredBotActivity('bot-1', { type: 'playing', name: 'chess' });
    expect(connectionManager.getUserActivities('bot-1')).toEqual([]);
    expect(queuePresenceRelay).not.toHaveBeenCalled();
  });
});
