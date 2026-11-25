import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { Activity, ServerEvent } from '@backspace/shared';
import type { WebSocket } from 'ws';

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
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

type ReadyMessage = Extract<ServerEvent, { type: 'ready' }>;

const now = 1_700_000_000_000;
const playing: Activity[] = [{ type: 'playing', name: 'Factorio' }];

function seedUser(id: string, fields: { homeInstance?: string; homeUserId?: string; customStatus?: string } = {}): void {
  testDb.insert(schema.users).values({
    id,
    username: fields.homeInstance ? `${id}@${fields.homeInstance}` : id,
    passwordHash: 'x',
    homeUserId: fields.homeUserId ?? id,
    homeInstance: fields.homeInstance ?? null,
    customStatus: fields.customStatus ?? null,
    status: 'online',
    createdAt: now,
  }).run();
}

function befriend(a: string, b: string): void {
  testDb.insert(schema.friends).values({ userId: a, friendId: b, createdAt: now }).run();
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  // The viewer shares no space and no DM with any of the friends below.
  seedUser('viewer');
  seedUser('local-friend');
  seedUser('stub-bob', { homeInstance: 'orbit.test', homeUserId: 'bob-home' });
  seedUser('quiet-friend', { customStatus: 'brb' });
  befriend('viewer', 'local-friend');
  befriend('stub-bob', 'viewer');
  befriend('viewer', 'quiet-friend');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function readyFor(userId: string): Promise<ReadyMessage> {
  const { buildReadyPayload } = await import('./handler.js');
  return JSON.parse(JSON.stringify({ type: 'ready', ...buildReadyPayload(userId) })) as ReadyMessage;
}

describe("ready payload: friends' activities (#340)", () => {
  it('includes the activity of a friend with no shared space or DM', async () => {
    const { connectionManager } = await import('./handler.js');
    connectionManager.setUserActivities('local-friend', playing);
    const ready = await readyFor('viewer');
    expect(ready.userActivities?.['local-friend']).toEqual(playing);
    expect(ready.userActivityIdentities?.['local-friend']).toEqual({ homeUserId: null, homeInstance: null });
    connectionManager.clearUserActivities('local-friend');
  });

  it("includes a remote friend's relayed activity, named by the friend's home identity", async () => {
    const { connectionManager } = await import('./handler.js');
    connectionManager.setUserActivities('stub-bob', playing);
    const ready = await readyFor('viewer');
    expect(ready.userActivities?.['stub-bob']).toEqual(playing);
    expect(ready.userActivityIdentities?.['stub-bob']).toEqual({ homeUserId: 'bob-home', homeInstance: 'orbit.test' });
    connectionManager.clearUserActivities('stub-bob');
  });

  it("falls back to a friend's custom status, as for space and DM members", async () => {
    const ready = await readyFor('viewer');
    expect(ready.userActivities?.['quiet-friend']).toEqual([{ type: 'custom', name: 'brb' }]);
  });

  it('clears activities when the publishing socket disconnects, even if user has other connections', async () => {
    const { connectionManager } = await import('./handler.js');
    const wsDesktop = { send: vi.fn(), readyState: 1 } as unknown as WebSocket;
    const webSend = vi.fn();
    const wsWeb = { send: webSend, readyState: 1 } as unknown as WebSocket;

    connectionManager.addConnection('local-friend', wsDesktop);
    connectionManager.addConnection('local-friend', wsWeb);

    connectionManager.setUserActivities('local-friend', playing, wsDesktop);
    expect(connectionManager.getUserActivities('local-friend')).toEqual(playing);

    // Desktop app disconnects while Web client is still connected
    connectionManager.removeConnection(wsDesktop);

    // Activities must be immediately cleared!
    expect(connectionManager.getUserActivities('local-friend')).toEqual([]);
    // And wsWeb must receive presence_update with activities: []
    expect(webSend).toHaveBeenCalled();
    const sent = JSON.parse(webSend.mock.calls[0]![0]);
    expect(sent.type).toBe('presence_update');
    expect(sent.activities).toEqual([]);

    connectionManager.removeConnection(wsWeb);
  });

  it('projects media playback position by the time held on the server', async () => {
    const { connectionManager } = await import('./handler.js');
    vi.useFakeTimers();
    vi.setSystemTime(100_000);

    const media: Activity = {
      type: 'listening',
      name: 'Song',
      playback: { positionMs: 10_000, durationMs: 60_000 },
    };
    connectionManager.setUserActivities('local-friend', [media]);

    vi.advanceTimersByTime(5_000);
    const ready = await readyFor('viewer');
    expect(ready.userActivities?.['local-friend']).toEqual([{
      type: 'listening',
      name: 'Song',
      playback: { positionMs: 15_000, durationMs: 60_000 },
    }]);

    connectionManager.clearUserActivities('local-friend');
    vi.useRealTimers();
  });

  it('allows immediate activity clearing even inside the 3s rate limit window', async () => {
    const { connectionManager } = await import('./handler.js');
    vi.useFakeTimers();
    vi.setSystemTime(100_000);

    // Initial update consumes rate limit
    expect(connectionManager.checkActivityRateLimit('local-friend')).toBe(true);

    // 1 second later: normal update is rate-limited
    vi.advanceTimersByTime(1_000);
    expect(connectionManager.checkActivityRateLimit('local-friend', false)).toBe(false);

    // But clearing/reducing activities is permitted immediately
    expect(connectionManager.checkActivityRateLimit('local-friend', true)).toBe(true);

    vi.useRealTimers();
  });
});
