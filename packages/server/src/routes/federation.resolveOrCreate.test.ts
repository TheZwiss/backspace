import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

let _sf = 1;
vi.mock('../utils/snowflake.js', () => ({
  generateSnowflake: () => String(_sf++),
  setWorkerId: vi.fn(),
}));

// federation.ts also imports connectionManager/ws — stub minimal surface so
// the route module loads at test time. The function under test doesn't touch any of these.
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    evictFederatedCallsForHost: vi.fn(),
    federatedCalls: new Map(),
    isUserOnline: vi.fn(),
    lateBindFederatedCall: vi.fn(),
  },
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

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  _sf = 1;
});

describe('resolveOrCreateReplicatedUser — stub username', () => {
  it('creates stub with realname@domain when hint provides username', async () => {
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const created = resolveOrCreateReplicatedUser(
      '310002371434024960',
      'orbit.ddns.net',
      testDb,
      { username: 'pbtest3' },
    );
    expect(created).not.toBeNull();
    expect(created!.username).toBe('pbtest3@orbit.ddns.net');
    expect(created!.homeUserId).toBe('310002371434024960');
    expect(created!.homeInstance).toBe('orbit.ddns.net');
  });

  it('falls back to homeUserId@domain when no hint provided', async () => {
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const created = resolveOrCreateReplicatedUser(
      '310002371434024960',
      'orbit.ddns.net',
      testDb,
    );
    expect(created!.username).toBe('310002371434024960@orbit.ddns.net');
  });
});
