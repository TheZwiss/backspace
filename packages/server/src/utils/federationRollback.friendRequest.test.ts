import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
const sendToUser = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: { sendToUser },
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  sendToUser.mockReset();
});

describe('rollbackFriendRequestCreate', () => {
  it('deletes the matching friend_requests row and emits friend_request_relay_failed to sender', async () => {
    testDb.insert(schema.users).values([
      { id: 'sender', username: 'bob', passwordHash: 'x', status: 'offline', isAdmin: 0, createdAt: Date.now() },
      { id: 'stub', username: 'alice@orbit.test', passwordHash: '!federation-replicated',
        status: 'offline', isAdmin: 0, homeInstance: 'orbit.test', homeUserId: 'remote-1', createdAt: Date.now() },
    ] as typeof schema.users.$inferInsert[]).run();

    testDb.insert(schema.friendRequests).values({
      id: 'req-1',
      fromId: 'sender',
      toId: 'stub',
      status: 'pending',
      createdAt: Date.now(),
      relayMessageId: 'friend_req:remote-1:sender:1234',
    } as typeof schema.friendRequests.$inferInsert).run();

    const { rollbackFriendRequestCreate } = await import('./federationRollback.js');
    rollbackFriendRequestCreate('friend_req:remote-1:sender:1234', 'recipient_not_found');

    const remaining = testDb.select().from(schema.friendRequests).where(eq(schema.friendRequests.id, 'req-1')).get();
    expect(remaining).toBeUndefined();

    expect(sendToUser).toHaveBeenCalledOnce();
    const [userId, event] = sendToUser.mock.calls[0]!;
    expect(userId).toBe('sender');
    expect(event.type).toBe('friend_request_relay_failed');
    expect(event.requestId).toBe('req-1');
    expect(event.reason).toBe('user_not_found');
    expect(event.targetHandle).toBe('alice@orbit.test');
    expect(typeof event.message).toBe('string');
  });

  it('is idempotent: no-op if no row matches the messageId', async () => {
    const { rollbackFriendRequestCreate } = await import('./federationRollback.js');
    expect(() => rollbackFriendRequestCreate('no-such-msg', 'recipient_not_found')).not.toThrow();
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('maps unknown reasons to peer_rejected', async () => {
    testDb.insert(schema.users).values([
      { id: 'sender', username: 'bob', passwordHash: 'x', status: 'offline', isAdmin: 0, createdAt: Date.now() },
      { id: 'stub', username: 'alice@orbit.test', passwordHash: '!federation-replicated',
        status: 'offline', isAdmin: 0, homeInstance: 'orbit.test', homeUserId: 'remote-1', createdAt: Date.now() },
    ] as typeof schema.users.$inferInsert[]).run();
    testDb.insert(schema.friendRequests).values({
      id: 'req-2',
      fromId: 'sender',
      toId: 'stub',
      status: 'pending',
      createdAt: Date.now(),
      relayMessageId: 'msg-x',
    } as typeof schema.friendRequests.$inferInsert).run();

    const { rollbackFriendRequestCreate } = await import('./federationRollback.js');
    rollbackFriendRequestCreate('msg-x', 'attribution_mismatch');

    expect(sendToUser).toHaveBeenCalledOnce();
    const event = sendToUser.mock.calls[0]![1];
    expect(event.reason).toBe('peer_rejected');
  });
});
