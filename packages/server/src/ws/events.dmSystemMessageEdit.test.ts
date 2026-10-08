import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

const sendToUser = vi.fn();
const sendToWs = vi.fn();
vi.mock('./handler.js', () => ({
  connectionManager: {
    sendToUser: (...args: unknown[]) => sendToUser(...args),
    sendToWs: (...args: unknown[]) => sendToWs(...args),
    sendToDmMembers: vi.fn(),
    getAllOnlineUserIds: () => [],
  },
}));

const queueDmRelay = vi.fn();
vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return { ...actual, queueDmRelay: (...args: unknown[]) => queueDmRelay(...args) };
});

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
    isAdmin: 0, isDeleted: 0, discoverable: 1, homeInstance: null, homeUserId: null, createdAt: Date.now(),
  }).run();
}

describe('WS dm_message_edit on a system message', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    sendToUser.mockReset();
    sendToWs.mockReset();
    queueDmRelay.mockReset();
    seedUser('alice');
    seedUser('bob');
    const now = Date.now();
    testDb.insert(schema.dmChannels).values({ id: 'dm1', ownerId: 'alice', federatedId: null, createdAt: now }).run();
    testDb.insert(schema.dmMembers).values([{ dmChannelId: 'dm1', userId: 'alice', closed: 0 }, { dmChannelId: 'dm1', userId: 'bob', closed: 0 }]).run();
    testDb.insert(schema.dmMessages).values({
      id: 'm1', dmChannelId: 'dm1', userId: 'alice', type: 'system', createdAt: now,
      content: JSON.stringify({ event: 'name_changed', oldName: null, newName: 'Crew' }),
    }).run();
  });

  it('refuses the edit and leaves the row and the relay untouched', async () => {
    const { handleClientEvent } = await import('./events.js');
    const socket = {} as WebSocket;
    handleClientEvent({ type: 'dm_message_edit', messageId: 'm1', content: 'something else' }, 'alice', 'alice', socket, false);

    const row = testDb.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, 'm1')).get();
    expect(row?.content).toBe(JSON.stringify({ event: 'name_changed', oldName: null, newName: 'Crew' }));
    expect(row?.editedAt).toBeNull();
    expect(queueDmRelay).not.toHaveBeenCalled();
    // The refusal goes to the socket that sent the edit only.
    expect(sendToWs).toHaveBeenCalledWith(socket, expect.objectContaining({ type: 'error', code: 'system_message_immutable' }));
    expect(sendToUser).not.toHaveBeenCalled();
  });
});
