import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(id: string): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    passwordHash: 'x',
    homeUserId: id,
    homeInstance: null,
    createdAt: Date.now(),
  }).run();
}

function seedSpace(spaceId: string, ownerId: string): void {
  seedUser(ownerId);
  testDb.insert(schema.spaces).values({
    id: spaceId,
    name: 'Test Space',
    ownerId,
    createdAt: Date.now(),
  }).run();
}

function seedMember(spaceId: string, userId: string): void {
  seedUser(userId);
  testDb.insert(schema.spaceMembers).values({
    spaceId,
    userId,
    joinedAt: Date.now(),
  }).run();
}

function seedChannel(id: string, spaceId: string): void {
  testDb.insert(schema.channels).values({
    id,
    spaceId,
    name: id,
    type: 'voice',
    position: 0,
    createdAt: Date.now(),
  }).run();
}

function fakeWs(): { readyState: number; send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() };
}

async function importManager() {
  return (await import('./handler.js')).connectionManager;
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('voice_move channel duration', () => {
  it('reports the occupied duration of a channel a member is moved into', async () => {
    const cm = await importManager();
    const { handleClientEvent } = await import('./events.js');

    const spaceId = 'sp-move-1';
    const fromCh = 'vc-move-from';
    const toCh = 'vc-move-to';
    seedSpace(spaceId, 'owner');
    seedMember(spaceId, 'u-moved');
    seedChannel(fromCh, spaceId);
    seedChannel(toCh, spaceId);

    // The target channel is empty, so it has no room yet: leaveRoom tears space
    // rooms down when the last participant leaves. This is the ordinary case for
    // a move, and the duration must still reach the space.
    cm.createRoom(fromCh, 'space', { type: 'space', spaceId });
    cm.joinRoom(fromCh, 'u-moved');

    const ws = fakeWs();
    cm.addConnection('owner', ws as never);
    cm.addUserSpace('owner', spaceId);

    handleClientEvent(
      { type: 'voice_move', userId: 'u-moved', targetChannelId: toCh },
      'owner',
      'owner',
      ws as never,
      false,
    );

    const join = ws.send.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.type === 'voice_state_update' && e.action === 'join' && e.channelId === toCh);

    expect(join).toBeDefined();
    expect(join.channelElapsedSeconds).toBe(0);
  });
});
