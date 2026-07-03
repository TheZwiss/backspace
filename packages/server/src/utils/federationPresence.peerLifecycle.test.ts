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

const queueCalls: Array<{ entityId: string; eventType: string; targets: string[] | undefined; payload: string }> = [];
const sentToUser: Array<{ userId: string; payload: any }> = [];

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
  queueOutboxEvent: vi.fn((entityId, _ctxId, eventType, payload, targets) => {
    queueCalls.push({ entityId, eventType, targets, payload });
  }),
  appendMutationLog: vi.fn(),
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn((uid: string, p: any) => sentToUser.push({ userId: uid, payload: p })),
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
  queueCalls.length = 0;
  sentToUser.length = 0;
  // Stub from orbit (peer being activated)
  testDb.insert(schema.users).values({
    id: 'stub-pbtest3', username: 'pbtest3@orbit.ddns.net', passwordHash: '!fr',
    status: 'online', isAdmin: 0, homeInstance: 'orbit.ddns.net',
    homeUserId: 'remote-pbtest3', createdAt: Date.now(),
  }).run();
  // Online native FRIENDED with the stub — should be snapshotted
  testDb.insert(schema.users).values({
    id: 'native-friend', username: 'erin', passwordHash: 'x',
    status: 'online', isAdmin: 0, homeUserId: 'native-friend', createdAt: Date.now(),
  }).run();
  testDb.insert(schema.friends).values({
    userId: 'native-friend', friendId: 'stub-pbtest3', createdAt: Date.now(),
  }).run();
  // Online native sharing a DM with the stub — should be snapshotted
  testDb.insert(schema.users).values({
    id: 'native-dm', username: 'dmuser', passwordHash: 'x',
    status: 'online', isAdmin: 0, homeUserId: 'native-dm', createdAt: Date.now(),
  }).run();
  testDb.insert(schema.dmChannels).values({
    id: 'dm-1', ownerId: null, federatedId: null, createdAt: Date.now(),
  }).run();
  testDb.insert(schema.dmMembers).values([
    { dmChannelId: 'dm-1', userId: 'native-dm', closed: 0 },
    { dmChannelId: 'dm-1', userId: 'stub-pbtest3', closed: 0 },
  ]).run();
  // Online native with replicatedInstances opt-in for orbit — should be snapshotted
  testDb.insert(schema.users).values({
    id: 'native-optin', username: 'optin', passwordHash: 'x',
    status: 'online', isAdmin: 0, homeUserId: 'native-optin',
    replicatedInstances: JSON.stringify([{ origin: 'https://orbit.ddns.net', domain: 'orbit.ddns.net' }]),
    createdAt: Date.now(),
  }).run();
  // Online native with NO relationship to orbit — must NOT be snapshotted
  testDb.insert(schema.users).values({
    id: 'native-unrelated', username: 'unrelated', passwordHash: 'x',
    status: 'online', isAdmin: 0, homeUserId: 'native-unrelated', createdAt: Date.now(),
  }).run();
  // Offline native that IS a friend of the stub — must NOT be snapshotted (offline)
  testDb.insert(schema.users).values({
    id: 'native-offline-friend', username: 'sleepyfriend', passwordHash: 'x',
    status: 'offline', isAdmin: 0, homeUserId: 'native-offline-friend', createdAt: Date.now(),
  }).run();
  testDb.insert(schema.friends).values({
    userId: 'native-offline-friend', friendId: 'stub-pbtest3', createdAt: Date.now(),
  }).run();
});

describe('snapshotPresenceForPeer — scope', () => {
  it('snapshots online natives that are friended with a peer stub', async () => {
    const { snapshotPresenceForPeer } = await import('./federationPresence.js');
    snapshotPresenceForPeer('https://orbit.ddns.net');
    const friendCall = queueCalls.find((c) => c.entityId === 'native-friend');
    expect(friendCall).toBeDefined();
    expect(friendCall!.targets).toEqual(['https://orbit.ddns.net']);
  });

  it('snapshots online natives that share a DM with a peer stub', async () => {
    const { snapshotPresenceForPeer } = await import('./federationPresence.js');
    snapshotPresenceForPeer('https://orbit.ddns.net');
    expect(queueCalls.find((c) => c.entityId === 'native-dm')).toBeDefined();
  });

  it('snapshots online natives that opted into client-federation (replicatedInstances)', async () => {
    const { snapshotPresenceForPeer } = await import('./federationPresence.js');
    snapshotPresenceForPeer('https://orbit.ddns.net');
    expect(queueCalls.find((c) => c.entityId === 'native-optin')).toBeDefined();
  });

  it('does NOT snapshot online natives with no relationship to the peer', async () => {
    const { snapshotPresenceForPeer } = await import('./federationPresence.js');
    snapshotPresenceForPeer('https://orbit.ddns.net');
    expect(queueCalls.find((c) => c.entityId === 'native-unrelated')).toBeUndefined();
  });

  it('does NOT snapshot offline natives even when they are related to the peer', async () => {
    const { snapshotPresenceForPeer } = await import('./federationPresence.js');
    snapshotPresenceForPeer('https://orbit.ddns.net');
    expect(queueCalls.find((c) => c.entityId === 'native-offline-friend')).toBeUndefined();
  });
});

describe('markPeerStubsOffline', () => {
  it('flips all stubs from the deactivated peer to offline and broadcasts', async () => {
    const { markPeerStubsOffline } = await import('./federationPresence.js');
    await markPeerStubsOffline('https://orbit.ddns.net');

    const stub = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-pbtest3')).get();
    expect(stub!.status).toBe('offline');

    const friendBroadcast = sentToUser.find(
      (c) => c.userId === 'native-friend' && c.payload.userId === 'stub-pbtest3',
    );
    expect(friendBroadcast).toBeDefined();
    expect(friendBroadcast!.payload.status).toBe('offline');
    expect(friendBroadcast!.payload.type).toBe('presence_update');
  });
});
