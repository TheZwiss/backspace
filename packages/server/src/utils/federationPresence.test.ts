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

vi.mock('./federationAuth.js', async (importActual) => ({
  ...(await importActual<typeof import('./federationAuth.js')>()),
  getOurOrigin: () => 'https://nova.example',
}));

// snapshotPresenceForPeer reads the live activities of each user it snapshots.
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    getUserActivities: () => [],
    sendToUser: vi.fn(),
  },
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
    username: 'erin',
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

  it('sends an explicit empty list when there are no activities, so receivers clear', async () => {
    // An absent field means "unchanged" to a receiver (what a 1.6.1 sender's
    // status-only relay means), so "none" must be said with [].
    const { queuePresenceRelay } = await import('./federationPresence.js');
    queuePresenceRelay('native-1', 'online', []);
    const event = JSON.parse(queueCalls[0]!.payload);
    expect(event.presenceUpdate.activities).toEqual([]);
  });

  it('is a no-op for replicated users (homeInstance set)', async () => {
    testDb.insert(schema.users).values({
      id: 'stub-1',
      username: 'pbtest3@orbit.example',
      passwordHash: '!federation-replicated',
      status: 'online',
      isAdmin: 0,
      homeInstance: 'orbit.example',
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

describe('presence of a detached account (#310)', () => {
  /** A federated account of the reset home `reset.example`, as detaching found it. */
  function insertDetachedLegacyRow(): void {
    testDb.insert(schema.users).values({
      id: 'detached-1',
      username: 'kai@reset.example',
      passwordHash: 'real-hash',
      status: 'dnd',
      isAdmin: 0,
      homeInstance: 'reset.example',
      homeUserId: 'old-home-uid',
      federationHomeOrphaned: 1,
      replicatedInstances: JSON.stringify([{ origin: 'https://orbit.example', username: 'kai@nova.example' }]),
      createdAt: Date.now(),
    }).run();
  }

  it('relays the status under its identity here once detaching has homed it', async () => {
    insertDetachedLegacyRow();
    const { rehomeDetachedAccount } = await import('./detachedIdentity.js');
    rehomeDetachedAccount(sqlite, 'detached-1', 'https://nova.example');

    const { queuePresenceRelay } = await import('./federationPresence.js');
    queuePresenceRelay('detached-1', 'dnd', [{ type: 'playing', name: 'Factorio' }]);

    expect(queueCalls).toHaveLength(1);
    const call = queueCalls[0]!;
    expect(call.eventType).toBe('presence_update');
    expect(call.targetPeerOrigins).toBeUndefined(); // broadcast, like any native user
    const update = JSON.parse(call.payload).presenceUpdate;
    // Its local id at this instance's origin: never the former identity.
    expect(update.homeUserId).toBe('detached-1');
    expect(update.homeInstance).toBe('https://nova.example');
    expect(update.status).toBe('dnd');
    expect(update.activities).toEqual([{ type: 'playing', name: 'Factorio' }]);
    expect(JSON.stringify(update)).not.toContain('old-home-uid');
    expect(JSON.stringify(update)).not.toContain('reset.example');
  });

  it('sends a peer-activation snapshot for it like for any native user', async () => {
    insertDetachedLegacyRow();
    const { rehomeDetachedAccount } = await import('./detachedIdentity.js');
    rehomeDetachedAccount(sqlite, 'detached-1', 'https://nova.example');

    const { snapshotPresenceForPeer } = await import('./federationPresence.js');
    await snapshotPresenceForPeer('https://orbit.example');

    const forDetached = queueCalls.filter(c => c.entityId === 'detached-1');
    expect(forDetached).toHaveLength(1);
    expect(forDetached[0]!.targetPeerOrigins).toEqual(['https://orbit.example']);
    const update = JSON.parse(forDetached[0]!.payload).presenceUpdate;
    expect(update.homeUserId).toBe('detached-1');
    expect(update.homeInstance).toBe('https://nova.example');
    expect(update.status).toBe('dnd');
  });

  it('is not counted as a user of its former home when that peer activates', async () => {
    insertDetachedLegacyRow();
    const { rehomeDetachedAccount } = await import('./detachedIdentity.js');
    rehomeDetachedAccount(sqlite, 'detached-1', 'https://nova.example');
    // erin is friends with the detached account; were it still counted as one
    // of reset.example's users, erin's status would be snapshotted to the new
    // incarnation of that domain.
    testDb.insert(schema.friends).values({ userId: 'native-1', friendId: 'detached-1', createdAt: 1 }).run();

    const { snapshotPresenceForPeer } = await import('./federationPresence.js');
    await snapshotPresenceForPeer('https://reset.example');

    expect(queueCalls.filter(c => c.entityId === 'native-1')).toEqual([]);
  });
});
