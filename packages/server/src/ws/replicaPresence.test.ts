import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { Activity, FederationRelayEvent, UserStatus } from '@backspace/shared';

setWorkerId(1);

/**
 * #325: a replicated row's live status is its home instance's projection
 * (activity-presence.md, "DB Persistence"). A session of that user on this
 * instance shows 'online' while the projection says 'offline', and when the
 * session ends the row returns to the projection, instead of being written
 * 'offline' over whatever the home last said.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://orbit.test' };
});

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const playing: Activity[] = [{ type: 'playing', name: 'Factorio' }];

function seedErin(status: UserStatus): void {
  testDb.insert(schema.users).values({
    id: 'erin', username: 'erin@nova.test', passwordHash: 'federated-hash', homeUserId: 'erin-home',
    homeInstance: 'nova.test', status, createdAt: 1,
  }).run();
}

function statusOf(userId: string): string | null | undefined {
  return testDb.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId)).get()?.status;
}

interface Sock { readyState: number; send: ReturnType<typeof vi.fn> }
const friendSocket: Sock = { readyState: 1, send: vi.fn() };

function presenceSeenByFriend(): Array<{ userId: string; status: string }> {
  return friendSocket.send.mock.calls
    .map(([raw]) => JSON.parse(raw as string) as { type: string; userId: string; status: string })
    .filter(e => e.type === 'presence_update' && e.userId === 'erin')
    .map(e => ({ userId: e.userId, status: e.status }));
}

async function manager() {
  return (await import('./handler.js')).connectionManager;
}

/** A session of erin connects here, as the WebSocket auth path does it. */
async function erinConnects(): Promise<Sock> {
  const cm = await manager();
  const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'erin')).get()!;
  const status = cm.statusForConnect(row);
  testDb.update(schema.users).set({ status }).where(eq(schema.users.id, 'erin')).run();
  const ws: Sock = { readyState: 1, send: vi.fn() };
  cm.addConnection('erin', ws as never);
  return ws;
}

async function erinDisconnects(ws: Sock): Promise<void> {
  const cm = await manager();
  cm.removeConnection(ws as never);
  await vi.advanceTimersByTimeAsync(5_000);
}

async function homeProjects(status: UserStatus, activities?: Activity[]): Promise<void> {
  const { processPresenceUpdateEvent } = await import('../routes/federation/events/dmState.js');
  const event: FederationRelayEvent = {
    eventType: 'presence_update', messageId: `p-${status}-${Date.now()}`, encryptionVersion: 0, timestamp: Date.now(),
    presenceUpdate: { homeUserId: 'erin-home', homeInstance: 'https://nova.test', status, ts: Date.now(), ...(activities ? { activities } : {}) },
  };
  processPresenceUpdateEvent(event, 'https://nova.test', testDb, [], []);
}

beforeEach(async () => {
  vi.useFakeTimers();
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  testDb.insert(schema.users).values({ id: 'friend', username: 'friend', passwordHash: 'x', status: 'online', createdAt: 1 }).run();
  friendSocket.send.mockReset();
  (await manager()).addConnection('friend', friendSocket as never);
});

afterEach(async () => {
  (await manager()).removeConnection(friendSocket as never);
  vi.useRealTimers();
});

function befriendErin(): void {
  testDb.insert(schema.friends).values({ userId: 'friend', friendId: 'erin', createdAt: 1 }).run();
}

describe('a replicated user\'s session here ends', () => {
  it('the row returns to the home\'s projection (dnd), not offline, and no one is told offline', async () => {
    seedErin('dnd');
    befriendErin();
    const ws = await erinConnects();
    expect(statusOf('erin')).toBe('dnd');
    await erinDisconnects(ws);
    expect(statusOf('erin')).toBe('dnd');
    expect(presenceSeenByFriend().filter(e => e.status === 'offline')).toEqual([]);
  });

  it('the next session starts from the projection again', async () => {
    seedErin('dnd');
    await erinDisconnects(await erinConnects());
    const ws = await erinConnects();
    expect(statusOf('erin')).toBe('dnd');
    await erinDisconnects(ws);
  });

  it('with no projection (offline), the session shows online and its end goes back to offline', async () => {
    seedErin('offline');
    befriendErin();
    const ws = await erinConnects();
    expect(statusOf('erin')).toBe('online');
    await erinDisconnects(ws);
    expect(statusOf('erin')).toBe('offline');
    expect(presenceSeenByFriend()).toContainEqual({ userId: 'erin', status: 'offline' });
  });

  it('a projection that arrives during the session is what the row returns to', async () => {
    seedErin('online');
    const ws = await erinConnects();
    await homeProjects('idle');
    expect(statusOf('erin')).toBe('idle');
    await erinDisconnects(ws);
    expect(statusOf('erin')).toBe('idle');
  });

  it('a projection of offline during the session shows online until the session ends', async () => {
    seedErin('dnd');
    const ws = await erinConnects();
    await homeProjects('offline');
    expect(statusOf('erin')).toBe('online');
    await erinDisconnects(ws);
    expect(statusOf('erin')).toBe('offline');
  });

  it('keeps the activities the home relayed', async () => {
    seedErin('online');
    const ws = await erinConnects();
    await homeProjects('online', playing);
    await erinDisconnects(ws);
    expect((await manager()).getUserActivities('erin')).toEqual(playing);
  });
});

describe('a native user\'s session here ends', () => {
  it('the row is written offline, as before', async () => {
    testDb.insert(schema.users).values({ id: 'nat', username: 'nat', passwordHash: 'x', status: 'offline', chosenStatus: 'dnd', createdAt: 1 }).run();
    const cm = await manager();
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'nat')).get()!;
    const status = cm.statusForConnect(row);
    expect(status).toBe('dnd');
    testDb.update(schema.users).set({ status }).where(eq(schema.users.id, 'nat')).run();
    const ws: Sock = { readyState: 1, send: vi.fn() };
    cm.addConnection('nat', ws as never);
    cm.removeConnection(ws as never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statusOf('nat')).toBe('offline');
  });
});
