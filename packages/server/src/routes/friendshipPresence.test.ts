import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { Activity, FederationRelayEvent, ServerEvent } from '@backspace/shared';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

// #340: when a friendship forms, each side learns the other's current presence
// (status and activities) at once, and the home of a native side tells the
// other side's home, so a game that started before the friendship shows.
//
// This instance is nova.test. alice is native here; bob is native on
// orbit.test and held here as the replicated row stub-bob.

const OUR_ORIGIN = 'https://nova.test';
const ORBIT = 'orbit.test';
const playing: Activity[] = [{ type: 'playing', name: 'Factorio' }];

type PresenceUpdate = Extract<ServerEvent, { type: 'presence_update' }>;
const sent: Array<{ userId: string; payload: ServerEvent }> = [];
const queued: Array<{ entityId: string; eventType: string; payload: string; targets: string[] | undefined }> = [];
const activities = new Map<string, Activity[]>();
/** Makes the presence lookup throw, to prove presence never fails a friendship. */
let presenceBroken = false;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = 'alice';
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn((userId: string, payload: ServerEvent) => { sent.push({ userId, payload }); }),
    sendToAdmins: vi.fn(),
    sendToDmMembers: vi.fn(),
    getAllOnlineUserIds: () => [],
    isUserOnline: () => true,
    getUserActivities: (userId: string) => {
      if (presenceBroken) throw new Error('presence store unavailable');
      return activities.get(userId) ?? [];
    },
  },
}));

vi.mock('../utils/federationOutbox.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationOutbox.js')>();
  return {
    ...actual,
    isFederationRelayEnabled: () => true,
    appendMutationLog: vi.fn(),
    queueOutboxEvent: vi.fn((entityId: string, _contextId: string, eventType: string, payload: string, targets?: string[]) => {
      queued.push({ entityId, eventType, payload, targets });
    }),
  };
});

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => OUR_ORIGIN };
});

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  sent.length = 0;
  queued.length = 0;
  activities.clear();
  presenceBroken = false;
  testDb.insert(schema.users).values([
    {
      id: 'alice', username: 'alice', passwordHash: 'x', status: 'online', isAdmin: 0,
      homeUserId: 'alice', createdAt: 1,
    },
    {
      id: 'stub-bob', username: 'bob@orbit.test', displayName: 'bob', passwordHash: '!federation-replicated',
      status: 'online', isAdmin: 0, homeInstance: ORBIT, homeUserId: 'bob-home', createdAt: 1,
    },
  ]).run();
});

function presenceTo(userId: string, aboutId: string): PresenceUpdate | undefined {
  const hit = sent.find(s => s.userId === userId && s.payload.type === 'presence_update' && s.payload.userId === aboutId);
  return hit?.payload as PresenceUpdate | undefined;
}

async function relayedPresenceOf(userId: string): Promise<{ targets: string[] | undefined; event: FederationRelayEvent } | undefined> {
  // The S2S snapshot is queued through a lazily imported module.
  await vi.waitFor(() => {
    if (!queued.some(q => q.eventType === 'presence_update' && q.entityId === userId)) throw new Error('not queued yet');
  }).catch(() => undefined);
  const hit = queued.find(q => q.eventType === 'presence_update' && q.entityId === userId);
  return hit ? { targets: hit.targets, event: JSON.parse(hit.payload) as FederationRelayEvent } : undefined;
}

function friendship(status?: 'accepted'): FederationRelayEvent['friendship'] {
  return {
    from: { homeUserId: 'alice', homeInstance: OUR_ORIGIN },
    to: { homeUserId: 'bob-home', homeInstance: ORBIT },
    ...(status ? { status } : {}),
    createdAt: 2,
  };
}

/** alice's pending request to bob, as her home holds it while it waits for bob's answer. */
function alicesPendingRequest(id: string): void {
  testDb.insert(schema.friendRequests).values({
    id, fromId: 'alice', toId: 'stub-bob', status: 'pending', createdAt: 1,
  }).run();
}

function presenceCountTo(userId: string, aboutId: string): number {
  return sent.filter(s => s.userId === userId && s.payload.type === 'presence_update' && s.payload.userId === aboutId).length;
}

function presenceRelayCount(userId: string): number {
  return queued.filter(q => q.eventType === 'presence_update' && q.entityId === userId).length;
}

function friendAdd(messageId: string): FederationRelayEvent {
  return { eventType: 'friend_add', contextType: 'friend', messageId, encryptionVersion: 0, timestamp: 2, friendship: friendship() };
}

function acceptedUpdate(messageId: string): FederationRelayEvent {
  return { eventType: 'friend_request_update', contextType: 'friend', messageId, encryptionVersion: 0, timestamp: 2, friendship: friendship('accepted') };
}

describe('friendship presence snapshot: local accept (PATCH /api/social/requests/:id)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    testDb.insert(schema.friendRequests).values({
      id: 'req-1', fromId: 'stub-bob', toId: 'alice', status: 'pending', createdAt: 1,
    }).run();
    app = Fastify({ logger: false });
    const { socialRoutes } = await import('./social.js');
    await app.register(socialRoutes);
    await app.ready();
  });

  it("tells each side the other's status and activities", async () => {
    activities.set('alice', playing);
    activities.set('stub-bob', [{ type: 'listening', name: 'Radio' }]);
    const res = await app.inject({ method: 'PATCH', url: '/api/social/requests/req-1', payload: { status: 'accepted' } });
    expect(res.statusCode).toBe(200);

    const aboutBob = presenceTo('alice', 'stub-bob');
    expect(aboutBob).toMatchObject({ status: 'online', activities: [{ type: 'listening', name: 'Radio' }], homeUserId: 'bob-home', homeInstance: ORBIT });
    const aboutAlice = presenceTo('stub-bob', 'alice');
    expect(aboutAlice).toMatchObject({ status: 'online', activities: playing, homeUserId: null, homeInstance: null });
  });

  it("sends the native side's presence to the other side's home", async () => {
    activities.set('alice', playing);
    await app.inject({ method: 'PATCH', url: '/api/social/requests/req-1', payload: { status: 'accepted' } });

    const relay = await relayedPresenceOf('alice');
    expect(relay?.targets).toEqual([`https://${ORBIT}`]);
    expect(relay?.event.presenceUpdate).toMatchObject({ homeUserId: 'alice', homeInstance: OUR_ORIGIN, status: 'online', activities: playing });
  });

  it('still answers 200 and relays the friendship when the presence snapshot fails', async () => {
    presenceBroken = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await app.inject({ method: 'PATCH', url: '/api/social/requests/req-1', payload: { status: 'accepted' } });
    expect(res.statusCode).toBe(200);
    expect(queued.some(q => q.eventType === 'friend_request_update')).toBe(true);
    expect(queued.some(q => q.eventType === 'friend_add')).toBe(true);
  });

  it('sends no presence when the request is declined', async () => {
    await app.inject({ method: 'PATCH', url: '/api/social/requests/req-1', payload: { status: 'declined' } });
    expect(presenceTo('alice', 'stub-bob')).toBeUndefined();
  });
});

describe('friendship presence snapshot: relayed friend_add', () => {
  it("tells the local side the remote friend's kept activities and relays the local side's presence home", async () => {
    activities.set('stub-bob', playing);
    activities.set('alice', [{ type: 'watching', name: 'A film' }]);
    alicesPendingRequest('req-fa');
    const fed = await import('./federation/events/friends.js');
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processFriendAddEvent(friendAdd('fa-1'), `https://${ORBIT}`, testDb, accepted, rejected);
    expect(rejected).toEqual([]);

    expect(presenceTo('alice', 'stub-bob')).toMatchObject({ status: 'online', activities: playing, homeUserId: 'bob-home', homeInstance: ORBIT });
    const relay = await relayedPresenceOf('alice');
    expect(relay?.targets).toEqual([`https://${ORBIT}`]);
    expect(relay?.event.presenceUpdate?.activities).toEqual([{ type: 'watching', name: 'A film' }]);
  });

  it('sends no presence for a friend_add that answers no pending request', async () => {
    activities.set('stub-bob', playing);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fed = await import('./federation/events/friends.js');
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processFriendAddEvent(friendAdd('fa-none'), `https://${ORBIT}`, testDb, [], rejected);
    await vi.dynamicImportSettled();

    expect(rejected).toEqual([{ messageId: 'fa-none', reason: 'invalid_target' }]);
    expect(sent.filter(s => s.payload.type === 'presence_update')).toEqual([]);
    expect(presenceRelayCount('alice')).toBe(0);
  });
});

describe('friendship presence snapshot: one exchange per friendship', () => {
  it('exchanges presence once when the accepted update is followed by its friend_add', async () => {
    activities.set('stub-bob', playing);
    alicesPendingRequest('req-seq');
    const fed = await import('./federation/events/friends.js');
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processFriendRequestUpdateEvent(acceptedUpdate('fu-seq'), `https://${ORBIT}`, testDb, accepted, rejected);
    await fed.processFriendAddEvent(friendAdd('fa-seq'), `https://${ORBIT}`, testDb, accepted, rejected);
    await vi.dynamicImportSettled();

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['fu-seq', 'fa-seq']);
    expect(presenceCountTo('alice', 'stub-bob')).toBe(1);
    expect(presenceCountTo('stub-bob', 'alice')).toBe(1);
    expect(presenceRelayCount('alice')).toBe(1);
  });

  it('exchanges presence once when the friend_add arrives before the accepted update', async () => {
    alicesPendingRequest('req-rev');
    const fed = await import('./federation/events/friends.js');
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processFriendAddEvent(friendAdd('fa-rev'), `https://${ORBIT}`, testDb, accepted, rejected);
    fed.processFriendRequestUpdateEvent(acceptedUpdate('fu-rev'), `https://${ORBIT}`, testDb, accepted, rejected);
    await vi.dynamicImportSettled();

    expect(rejected).toEqual([]);
    expect(presenceCountTo('alice', 'stub-bob')).toBe(1);
    expect(presenceRelayCount('alice')).toBe(1);
  });

  it('sends no presence for an accepted update when the two are already friends', async () => {
    // A request left pending next to an existing friendship forms nothing new.
    testDb.insert(schema.friends).values({ userId: 'alice', friendId: 'stub-bob', createdAt: 1 }).run();
    alicesPendingRequest('req-old');
    const fed = await import('./federation/events/friends.js');
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processFriendRequestUpdateEvent(acceptedUpdate('fu-old'), `https://${ORBIT}`, testDb, [], rejected);
    await vi.dynamicImportSettled();

    expect(rejected).toEqual([]);
    expect(sent.filter(s => s.payload.type === 'presence_update')).toEqual([]);
    expect(presenceRelayCount('alice')).toBe(0);
  });
});

describe('friendship presence snapshot: failure isolation', () => {
  it('accepts a relayed friend_add when the presence snapshot fails', async () => {
    presenceBroken = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    alicesPendingRequest('req-fx');
    const fed = await import('./federation/events/friends.js');
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processFriendAddEvent(friendAdd('fa-x'), `https://${ORBIT}`, testDb, accepted, rejected);
    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['fa-x']);
  });

  it('accepts a relayed friend_request_update when the presence snapshot fails', async () => {
    presenceBroken = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    testDb.insert(schema.friendRequests).values({
      id: 'req-x', fromId: 'alice', toId: 'stub-bob', status: 'pending', createdAt: 1,
    }).run();
    const fed = await import('./federation/events/friends.js');
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processFriendRequestUpdateEvent(
      { eventType: 'friend_request_update', contextType: 'friend', messageId: 'fu-x', encryptionVersion: 0, timestamp: 2, friendship: friendship('accepted') },
      `https://${ORBIT}`, testDb, accepted, rejected,
    );
    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['fu-x']);
  });
});

describe('friendship presence snapshot: relayed friend_request_update (accepted)', () => {
  it("tells the requester the new friend's presence", async () => {
    activities.set('stub-bob', playing);
    testDb.insert(schema.friendRequests).values({
      id: 'req-2', fromId: 'alice', toId: 'stub-bob', status: 'pending', createdAt: 1,
    }).run();
    const fed = await import('./federation/events/friends.js');
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processFriendRequestUpdateEvent(
      { eventType: 'friend_request_update', contextType: 'friend', messageId: 'fu-1', encryptionVersion: 0, timestamp: 2, friendship: friendship('accepted') },
      `https://${ORBIT}`, testDb, [], rejected,
    );
    expect(rejected).toEqual([]);
    expect(presenceTo('alice', 'stub-bob')).toMatchObject({ status: 'online', activities: playing, homeUserId: 'bob-home', homeInstance: ORBIT });
  });
});
