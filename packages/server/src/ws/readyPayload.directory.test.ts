import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { SpaceWithChannelsAndMembers } from '@backspace/shared';

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

const OWNER_ID = 'owner';
const now = 1_700_000_000_000;

function seedListedSpace(spaceId: string, directoryListed: 0 | 1): void {
  testDb.insert(schema.spaces).values({
    id: spaceId,
    name: `Space ${spaceId}`,
    ownerId: OWNER_ID,
    inviteCode: `inv-${spaceId}`,
    visibility: 'public',
    directoryListed,
    createdAt: now,
  }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId, userId: OWNER_ID, joinedAt: now }).run();
}

interface ReadyMessage {
  type: string;
  spaces: SpaceWithChannelsAndMembers[];
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  testDb.insert(schema.users).values({
    id: OWNER_ID,
    username: OWNER_ID,
    passwordHash: 'x',
    homeUserId: OWNER_ID,
    homeInstance: null,
    createdAt: now,
  }).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ready payload directoryListed projection', () => {
  it('reports each space with its stored directory_listed flag', async () => {
    const { connectionManager } = await import('./handler.js');
    seedListedSpace('sp-listed', 1);
    seedListedSpace('sp-unlisted', 0);

    const ws = { readyState: 1, send: vi.fn() };
    connectionManager.addConnection(OWNER_ID, ws as never);
    connectionManager.pushReadyPayload(OWNER_ID);
    connectionManager.removeConnection(ws as never);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const raw = ws.send.mock.calls[0]?.[0];
    expect(typeof raw).toBe('string');
    const message = JSON.parse(raw as string) as ReadyMessage;
    expect(message.type).toBe('ready');
    const byId = new Map(message.spaces.map(s => [s.id, s.directoryListed]));
    expect(byId.get('sp-listed')).toBe(true);
    expect(byId.get('sp-unlisted')).toBe(false);
  });
});
