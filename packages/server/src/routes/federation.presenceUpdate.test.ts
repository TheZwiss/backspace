import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { FederationRelayEvent } from '@backspace/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const sentToUserCalls: Array<{ userId: string; payload: any }> = [];
const retainedActivities = new Map<string, unknown[]>();

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn((uid: string, p: any) => sentToUserCalls.push({ userId: uid, payload: p })),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    evictFederatedCallsForHost: vi.fn(),
    federatedCalls: new Map(),
    isUserOnline: vi.fn(),
    // No session of the user here: the row shows the projection as sent.
    applyReplicaProjection: (_uid: string, projection: string) => projection,
    lateBindFederatedCall: vi.fn(),
    setUserActivities: vi.fn((uid: string, acts: unknown[]) => {
      if (acts.length === 0) retainedActivities.delete(uid);
      else retainedActivities.set(uid, acts);
    }),
    getUserActivities: vi.fn((uid: string) => retainedActivities.get(uid) ?? []),
    clearUserActivities: vi.fn((uid: string) => { retainedActivities.delete(uid); }),
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
  sentToUserCalls.length = 0;
  retainedActivities.clear();
  // Local user (erin) and replicated stub (pbtest3) — they're friends.
  testDb.insert(schema.users).values([
    {
      id: 'local-erin', username: 'erin', passwordHash: 'x', status: 'online', isAdmin: 0,
      homeUserId: 'local-erin', createdAt: Date.now(),
    },
    {
      id: 'stub-pbtest3', username: 'pbtest3@orbit.ddns.net', displayName: 'pbtest3',
      passwordHash: '!federation-replicated', status: 'offline', isAdmin: 0,
      homeInstance: 'orbit.ddns.net', homeUserId: 'home-pbtest3', createdAt: Date.now(),
    },
  ]).run();
  testDb.insert(schema.friends).values({
    userId: 'local-erin', friendId: 'stub-pbtest3', createdAt: Date.now(),
  }).run();
});

describe('processPresenceUpdateEvent', () => {
  it('updates stub status and broadcasts presence_update to local friends', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'presence_update',
      contextType: 'profile',
      messageId: 'p1',
      encryptionVersion: 0,
      timestamp: Date.now(),
      presenceUpdate: {
        homeUserId: 'home-pbtest3',
        homeInstance: 'orbit.ddns.net',
        status: 'online',
        ts: Date.now(),
      },
    };
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processPresenceUpdateEvent(event, 'orbit.ddns.net', testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['p1']);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-pbtest3')).get();
    expect(row!.status).toBe('online');

    const broadcast = sentToUserCalls.find((c) => c.userId === 'local-erin');
    expect(broadcast).toBeDefined();
    expect(broadcast!.payload.type).toBe('presence_update');
    expect(broadcast!.payload.userId).toBe('stub-pbtest3');
    expect(broadcast!.payload.status).toBe('online');
  });

  it('rejects on attribution mismatch', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'presence_update', contextType: 'profile', messageId: 'p2',
      encryptionVersion: 0, timestamp: Date.now(),
      presenceUpdate: {
        homeUserId: 'home-pbtest3', homeInstance: 'orbit.ddns.net',
        status: 'online', ts: Date.now(),
      },
    };
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processPresenceUpdateEvent(event, 'evil.example.com', testDb, [], rejected);
    expect(rejected).toEqual([{ messageId: 'p2', reason: 'attribution_mismatch' }]);
  });

  it('silently accepts when no replica exists locally', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'presence_update', contextType: 'profile', messageId: 'p3',
      encryptionVersion: 0, timestamp: Date.now(),
      presenceUpdate: {
        homeUserId: 'unknown-id', homeInstance: 'orbit.ddns.net',
        status: 'online', ts: Date.now(),
      },
    };
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processPresenceUpdateEvent(event, 'orbit.ddns.net', testDb, accepted, rejected);
    expect(accepted).toEqual(['p3']);
    expect(rejected).toEqual([]);
  });

  it('rejects invalid status values', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'presence_update', contextType: 'profile', messageId: 'p4',
      encryptionVersion: 0, timestamp: Date.now(),
      presenceUpdate: {
        homeUserId: 'home-pbtest3', homeInstance: 'orbit.ddns.net',
        status: 'invisible' as any, ts: Date.now(),
      },
    };
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processPresenceUpdateEvent(event, 'orbit.ddns.net', testDb, [], rejected);
    expect(rejected).toEqual([{ messageId: 'p4', reason: 'invalid_status' }]);
  });

  it('passes activities through to the WS broadcast when present', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'presence_update', contextType: 'profile', messageId: 'p5',
      encryptionVersion: 0, timestamp: Date.now(),
      presenceUpdate: {
        homeUserId: 'home-pbtest3', homeInstance: 'orbit.ddns.net',
        status: 'online', activities: [{ type: 'playing', name: 'Test' }],
        ts: Date.now(),
      },
    };
    fed.processPresenceUpdateEvent(event, 'orbit.ddns.net', testDb, [], []);
    const broadcast = sentToUserCalls.find((c) => c.userId === 'local-erin');
    expect(broadcast!.payload.activities).toEqual([{ type: 'playing', name: 'Test' }]);
  });
});

function relayed(messageId: string, fields: { status: 'online' | 'idle' | 'dnd' | 'offline'; activities?: Array<{ type: 'playing'; name: string }> }): FederationRelayEvent {
  return {
    eventType: 'presence_update', contextType: 'profile', messageId,
    encryptionVersion: 0, timestamp: Date.now(),
    presenceUpdate: { homeUserId: 'home-pbtest3', homeInstance: 'orbit.ddns.net', ts: Date.now(), ...fields },
  };
}

describe('processPresenceUpdateEvent: the relayed activity snapshot (#340)', () => {
  it("names the subject's federated identity in the WS broadcast", async () => {
    const fed = await import('./federation.js');
    fed.processPresenceUpdateEvent(relayed('i1', { status: 'online' }), 'orbit.ddns.net', testDb, [], []);
    const broadcast = sentToUserCalls.find((c) => c.userId === 'local-erin');
    expect(broadcast!.payload.homeUserId).toBe('home-pbtest3');
    expect(broadcast!.payload.homeInstance).toBe('orbit.ddns.net');
  });

  it('keeps the relayed activities on the replicated row', async () => {
    const fed = await import('./federation.js');
    fed.processPresenceUpdateEvent(relayed('k1', { status: 'online', activities: [{ type: 'playing', name: 'Factorio' }] }), 'orbit.ddns.net', testDb, [], []);
    expect(retainedActivities.get('stub-pbtest3')).toEqual([{ type: 'playing', name: 'Factorio' }]);
  });

  it('drops the kept activities on an explicit empty list, and tells local users', async () => {
    const fed = await import('./federation.js');
    fed.processPresenceUpdateEvent(relayed('c1', { status: 'online', activities: [{ type: 'playing', name: 'Factorio' }] }), 'orbit.ddns.net', testDb, [], []);
    sentToUserCalls.length = 0;
    fed.processPresenceUpdateEvent(relayed('c2', { status: 'online', activities: [] }), 'orbit.ddns.net', testDb, [], []);
    expect(retainedActivities.has('stub-pbtest3')).toBe(false);
    const broadcast = sentToUserCalls.find((c) => c.userId === 'local-erin');
    expect(broadcast!.payload.activities).toEqual([]);
  });

  it('keeps the kept activities when a relay carries no activities field (an older sender)', async () => {
    // A 1.6.1 home sends status-only relays on every connect and in its
    // peer-activation snapshot, also while its user is playing.
    const fed = await import('./federation.js');
    fed.processPresenceUpdateEvent(relayed('u1', { status: 'online', activities: [{ type: 'playing', name: 'Factorio' }] }), 'orbit.ddns.net', testDb, [], []);
    sentToUserCalls.length = 0;
    fed.processPresenceUpdateEvent(relayed('u2', { status: 'idle' }), 'orbit.ddns.net', testDb, [], []);
    expect(retainedActivities.get('stub-pbtest3')).toEqual([{ type: 'playing', name: 'Factorio' }]);
    const broadcast = sentToUserCalls.find((c) => c.userId === 'local-erin');
    expect(broadcast!.payload.status).toBe('idle');
    expect(broadcast!.payload.activities).toBeUndefined();
  });

  it('drops the kept activities when the user goes offline', async () => {
    const fed = await import('./federation.js');
    fed.processPresenceUpdateEvent(relayed('o1', { status: 'online', activities: [{ type: 'playing', name: 'Factorio' }] }), 'orbit.ddns.net', testDb, [], []);
    fed.processPresenceUpdateEvent(relayed('o2', { status: 'offline', activities: [{ type: 'playing', name: 'Factorio' }] }), 'orbit.ddns.net', testDb, [], []);
    expect(retainedActivities.has('stub-pbtest3')).toBe(false);
  });

  it('applies the status but not activities over the limits a local client is held to', async () => {
    const fed = await import('./federation.js');
    fed.processPresenceUpdateEvent(relayed('v0', { status: 'online', activities: [{ type: 'playing', name: 'Factorio' }] }), 'orbit.ddns.net', testDb, [], []);
    sentToUserCalls.length = 0;
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    const event = relayed('v1', { status: 'dnd' });
    event.presenceUpdate!.activities = [{ type: 'playing', name: 'x'.repeat(10_000) }];
    fed.processPresenceUpdateEvent(event, 'orbit.ddns.net', testDb, accepted, rejected);
    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['v1']);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-pbtest3')).get();
    expect(row!.status).toBe('dnd');
    expect(retainedActivities.get('stub-pbtest3')).toEqual([{ type: 'playing', name: 'Factorio' }]);
    const broadcast = sentToUserCalls.find((c) => c.userId === 'local-erin');
    expect(broadcast!.payload.status).toBe('dnd');
    expect(broadcast!.payload.activities).toBeUndefined();
  });
});
