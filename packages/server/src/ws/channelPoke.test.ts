import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { setWorkerId } from '../utils/snowflake.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../db/schema.js';
let sqlite: Database.Database;
let directory: string;
let db: ReturnType<typeof drizzle<typeof schema>>;
const mocks = vi.hoisted(() => ({ permission: vi.fn(), broadcast: vi.fn() }));
vi.mock('../utils/permissions.js', () => ({ getChannelSpaceId: () => 'space', hasPermission: mocks.permission, PermissionBits: { VIEW_CHANNEL: 1n, SEND_MESSAGES: 2n } }));
vi.mock('../db/index.js', () => ({ getDb: () => db, schema }));
vi.mock('./handler.js', () => ({ connectionManager: { sendToChannel: mocks.broadcast } }));
import { handleChannelPoke } from './channelPoke.js';
import { buildMessageWithUser } from '../routes/messages.js';
const send = vi.fn();
const poke = () => handleChannelPoke({ event: { channelId: 'chat', targetUserId: 'target', username: 'forged' }, userId: 'actor', ws: { send } as unknown as WebSocket });
beforeEach(() => {
  vi.clearAllMocks(); mocks.permission.mockReturnValue(true);
  setWorkerId(1);
  directory = mkdtempSync(join(tmpdir(), 'backspace-poke-'));
  sqlite = new Database(join(directory, 'test.sqlite'));
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  // This fixture only exercises message persistence, not space provisioning.
  sqlite.pragma('foreign_keys = OFF');
  db.insert(schema.users).values([
    { id: 'actor', username: 'Actor', passwordHash: 'test-only', displayName: 'Actor snapshot', createdAt: 1 },
    { id: 'target', username: 'Target', passwordHash: 'test-only', createdAt: 1 },
  ]).run();
});
afterEach(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
describe('persistent channel pokes', () => {
  it('persists before broadcasting and preserves the system type in history hydration', () => {
    mocks.broadcast.mockImplementation(() => expect(db.select().from(schema.messages).all()).toHaveLength(1));
    poke();
    // Reopen the real database to prove history does not depend on process memory.
    sqlite.close();
    sqlite = new Database(join(directory, 'test.sqlite'));
    db = drizzle(sqlite, { schema });
    const row = db.select().from(schema.messages).get()!;
    const actor = db.select().from(schema.users).where(eq(schema.users.id, 'actor')).get()!;
    const history = buildMessageWithUser(row, actor, []);
    expect(history.type).toBe('system');
    expect(JSON.parse(history.content!)).toEqual({ event: 'channel_poke', targetUserId: 'target', username: 'Actor snapshot', targetUsername: 'Target' });
    expect(mocks.broadcast.mock.calls[0]![2]).toMatchObject({ type: 'message_created', message: { id: row.id, type: 'system' } });
    expect(mocks.broadcast.mock.calls[1]![2].type).toBe('channel_poke');
    expect(send).not.toHaveBeenCalled();
  });
  it('does not persist or broadcast inaccessible and malformed requests', () => {
    mocks.permission.mockReturnValue(false);
    poke();
    handleChannelPoke({ event: { channelId: 123, targetUserId: {} }, userId: 'actor', ws: { send } as unknown as WebSocket });
    expect(db.select().from(schema.messages).all()).toHaveLength(0);
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('propagates database errors without broadcasting a fake success', () => {
    sqlite.exec("CREATE TRIGGER reject_poke BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    expect(poke).toThrow('storage failure');
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
  it('keeps ordinary messages as user messages by default', () => {
    db.insert(schema.messages).values({ id: '1', channelId: 'chat', userId: 'actor', content: 'hello', createdAt: 1 }).run();
    expect(db.select().from(schema.messages).get()!.type).toBe('user');
  });
});
