import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const queueCalls: Array<{
  entityId: string;
  contextId: string;
  eventType: string;
  payload: string;
  targetPeerOrigins: string[] | undefined;
  contextType: string;
}> = [];
const mutationLogCalls: Array<{ entityId: string; eventType: string }> = [];

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('./federationAuth.js', () => ({
  getOurOrigin: () => 'https://nova.ddns.net',
}));

vi.mock('./federationOutbox.js', () => ({
  isFederationRelayEnabled: () => true,
  queueOutboxEvent: vi.fn((entityId, contextId, eventType, payload, targetPeerOrigins, contextType) => {
    queueCalls.push({ entityId, contextId, eventType, payload, targetPeerOrigins, contextType });
  }),
  appendMutationLog: vi.fn((entityId, _ctxId, eventType) => {
    mutationLogCalls.push({ entityId, eventType });
  }),
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
  queueCalls.length = 0;
  mutationLogCalls.length = 0;
  // Native local user
  testDb.insert(schema.users).values({
    id: 'native-1',
    username: 'youruser',
    passwordHash: 'x',
    status: 'online',
    isAdmin: 0,
    homeUserId: 'native-1',
    createdAt: Date.now(),
  }).run();
});

describe('queuePresenceRelay', () => {
  it('queues an outbox event with status + activities for a native user', async () => {
    const { queuePresenceRelay } = await import('./federationPresence.js');
    queuePresenceRelay('native-1', 'online', [{ type: 'playing', name: 'Test' }]);

    expect(queueCalls.length).toBe(1);
    const call = queueCalls[0]!;
    expect(call.eventType).toBe('presence_update');
    expect(call.contextType).toBe('profile');
    expect(call.targetPeerOrigins).toBeUndefined(); // broadcast to all active peers
    const event = JSON.parse(call.payload);
    expect(event.eventType).toBe('presence_update');
    expect(event.presenceUpdate.status).toBe('online');
    expect(event.presenceUpdate.activities).toEqual([{ type: 'playing', name: 'Test' }]);
    // appendMutationLog NOT called — presence is outbox-only
    expect(mutationLogCalls).toEqual([]);
  });

  it('omits activities field when none are passed', async () => {
    const { queuePresenceRelay } = await import('./federationPresence.js');
    queuePresenceRelay('native-1', 'offline', []);
    const event = JSON.parse(queueCalls[0]!.payload);
    expect(event.presenceUpdate.activities).toBeUndefined();
  });

  it('is a no-op for replicated users (homeInstance set)', async () => {
    testDb.insert(schema.users).values({
      id: 'stub-1',
      username: 'pbtest3@orbit.ddns.net',
      passwordHash: '!federation-replicated',
      status: 'online',
      isAdmin: 0,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'remote-1',
      createdAt: Date.now(),
    }).run();
    const { queuePresenceRelay } = await import('./federationPresence.js');
    queuePresenceRelay('stub-1', 'online', []);
    expect(queueCalls).toEqual([]);
  });

  it('is a no-op for unknown user IDs', async () => {
    const { queuePresenceRelay } = await import('./federationPresence.js');
    queuePresenceRelay('does-not-exist', 'online', []);
    expect(queueCalls).toEqual([]);
  });
});
