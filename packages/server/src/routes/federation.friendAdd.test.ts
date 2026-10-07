// Relayed friendship events against the requester's own record.
//
// A friendship forms on the requester's instance only as the answer to a
// request the requester made there: `friend_request_create` leaves a pending
// `friend_requests` row (requester -> recipient) on the requester's home in
// the same transaction that queues the relay, before anything reaches the
// wire. The recipient's instance answers with `friend_request_update`
// (accepted) and `friend_add`. Either one, in either order, forms the
// friendship when that pending row is there; without it (never requested,
// requested the other way round, or already answered and since removed) a
// `friend_add` changes nothing.
//
// Two instances run in this process: `home.test` (alice) and `orbit.test`
// (bob). Each has its own database; `use()` points the mocked db module,
// origin and authenticated user at one of them. Events travel exactly as the
// outbox worker rebuilds them from `federation_outbox`, oldest first.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq, or } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { FederationRelayEvent } from '@backspace/shared';
import { connectionManager } from '../ws/handler.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOME = 'https://home.test';
const ORBIT = 'https://orbit.test';
const ALICE = 'alice-id';
const BOB = 'bob-id';

type Db = ReturnType<typeof drizzle<typeof schema>>;
interface Instance { origin: string; sqlite: Database.Database; db: Db; app: FastifyInstance | null }

let sqlite: Database.Database;
let testDb: Db;
let currentOrigin = HOME;
let currentUserId = ALICE;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => { req.userId = currentUserId; },
}));
vi.mock('../ws/handler.js', () => ({
  connectionManager: { sendToUser: vi.fn(), sendToAdmins: vi.fn(), sendToDmMembers: vi.fn(), getAllOnlineUserIds: () => [] },
}));
vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => currentOrigin };
});
vi.mock('../utils/federationPeering.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationPeering.js')>();
  return { ...actual, ensurePeered: vi.fn(async () => ({ status: 'active', peerId: 'peer' })), racePeering: vi.fn() };
});
// Each instance answers the other's by-name lookup for its native user.
vi.mock('../utils/federationLookup.js', () => ({
  lookupRemoteUser: vi.fn(async (origin: string, name: string) => {
    const known = origin === 'https://orbit.test' ? { name: 'bob', id: 'bob-id' } : { name: 'alice', id: 'alice-id' };
    if (name !== known.name) return { ok: false, reason: 'not_found' };
    return {
      ok: true, homeUserId: known.id, username: known.name,
      profile: { displayName: known.name, avatar: null, avatarColor: null, banner: null, bio: null, status: 'online' },
    };
  }),
  lookupRemoteUserByHomeId: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
}));
vi.mock('../utils/federationOriginResolve.js', () => ({
  resolveOriginFromHostname: (host: string) => `https://${host}`,
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function makeInstance(origin: string, nativeId: string, nativeName: string): Instance {
  const raw = new Database(':memory:');
  applyMigrations(raw);
  const db = drizzle(raw, { schema });
  db.insert(schema.users).values({
    id: nativeId, username: nativeName, passwordHash: 'x', status: 'online', isAdmin: 0, createdAt: Date.now(),
  }).run();
  raw.exec(`INSERT OR IGNORE INTO instance_settings (id, federation_relay_enabled, updated_at) VALUES (1, 1, ${Date.now()})`);
  return { origin, sqlite: raw, db, app: null };
}

let home: Instance;
let orbit: Instance;

function use(inst: Instance, userId: string): void {
  sqlite = inst.sqlite;
  testDb = inst.db;
  currentOrigin = inst.origin;
  currentUserId = userId;
}

async function appOf(inst: Instance): Promise<FastifyInstance> {
  if (!inst.app) {
    const app = Fastify({ logger: false });
    const { socialRoutes } = await import('./social.js');
    await app.register(socialRoutes);
    await app.ready();
    inst.app = app;
  }
  return inst.app;
}

/** Events `inst` queued, rebuilt as the outbox worker sends them (oldest first). */
function takeOutbox(inst: Instance, eventTypes: string[]): FederationRelayEvent[] {
  const rows = inst.db.select().from(schema.federationOutbox).orderBy(schema.federationOutbox.createdAt).all()
    .filter(r => eventTypes.includes(r.eventType));
  inst.db.delete(schema.federationOutbox).run();
  return rows.map(row => ({
    ...(JSON.parse(row.payload) as Partial<FederationRelayEvent>),
    eventType: row.eventType as FederationRelayEvent['eventType'],
    contextType: 'friend',
    messageId: row.entityId,
    encryptionVersion: 0,
    timestamp: row.createdAt,
  }));
}

async function deliver(to: Instance, from: Instance, events: FederationRelayEvent[]) {
  use(to, to === home ? ALICE : BOB);
  const { processRelayEvents } = await import('./federation.js');
  return processRelayEvents(events, from.origin, from.origin, to.db);
}

function userIdOf(inst: Instance, homeUserId: string): string | undefined {
  return inst.db.select().from(schema.users).where(eq(schema.users.homeUserId, homeUserId)).get()?.id;
}

function areFriends(inst: Instance, a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return inst.db.select().from(schema.friends).where(or(
    and(eq(schema.friends.userId, a), eq(schema.friends.friendId, b)),
    and(eq(schema.friends.userId, b), eq(schema.friends.friendId, a)),
  )).get() !== undefined;
}

/** alice (home.test) asks bob (orbit.test); orbit.test receives the create. */
async function aliceRequestsBob(): Promise<void> {
  use(home, ALICE);
  const res = await (await appOf(home)).inject({ method: 'POST', url: '/api/social/requests', payload: { username: 'bob@orbit.test' } });
  expect(res.statusCode).toBe(201);
  const created = await deliver(orbit, home, takeOutbox(home, ['friend_request_create']));
  expect(created.rejected).toEqual([]);
}

/** bob accepts on orbit.test; returns what orbit.test queued for home.test. */
async function bobAccepts(): Promise<FederationRelayEvent[]> {
  use(orbit, BOB);
  const pending = orbit.db.select().from(schema.friendRequests).where(eq(schema.friendRequests.toId, BOB)).get();
  expect(pending?.status).toBe('pending');
  const res = await (await appOf(orbit)).inject({ method: 'PATCH', url: `/api/social/requests/${pending!.id}`, payload: { status: 'accepted' } });
  expect(res.statusCode).toBe(200);
  return takeOutbox(orbit, ['friend_request_update', 'friend_add']);
}

/** A friend_add from orbit.test naming `from` as the requester and bob as the acceptor. */
function friendAdd(messageId: string, fromHomeUserId: string, fromInstance: string): FederationRelayEvent {
  return {
    eventType: 'friend_add',
    contextType: 'friend',
    messageId,
    encryptionVersion: 0,
    timestamp: Date.now(),
    friendship: {
      from: { homeUserId: fromHomeUserId, homeInstance: fromInstance },
      to: { homeUserId: BOB, homeInstance: ORBIT },
      fromProfile: { username: 'alice', displayName: 'Alice', avatar: null, avatarColor: null, banner: null, bio: null, status: null },
      toProfile: { username: 'bob', displayName: 'Bob', avatar: null, avatarColor: null, banner: null, bio: null, status: 'online' },
      createdAt: Date.now(),
    },
  };
}

beforeEach(() => {
  home = makeInstance(HOME, ALICE, 'alice');
  orbit = makeInstance(ORBIT, BOB, 'bob');
});

describe('a friendship forms on the requester\'s instance as the answer to its pending request', () => {
  it('the pending request exists on the requester\'s side as soon as the request is made, before any delivery', async () => {
    use(home, ALICE);
    const res = await (await appOf(home)).inject({ method: 'POST', url: '/api/social/requests', payload: { username: 'bob@orbit.test' } });
    expect(res.statusCode).toBe(201);
    const row = home.db.select().from(schema.friendRequests).where(eq(schema.friendRequests.fromId, ALICE)).get();
    expect(row?.status).toBe('pending');
    expect(home.db.select().from(schema.federationOutbox).all().map(r => r.eventType)).toEqual(['friend_request_create']);
  });

  it('friend_request_update then friend_add, in the order the recipient queued them, forms it once', async () => {
    await aliceRequestsBob();
    const events = await bobAccepts();
    expect(events.map(e => e.eventType)).toEqual(['friend_request_update', 'friend_add']);

    const result = await deliver(home, orbit, events);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(2);
    expect(areFriends(home, ALICE, userIdOf(home, BOB))).toBe(true);
    expect(home.db.select().from(schema.friends).all()).toHaveLength(1);
  });

  it('friend_request_update (accepted) alone forms it', async () => {
    await aliceRequestsBob();
    const [update] = await bobAccepts();
    expect(update!.eventType).toBe('friend_request_update');

    const result = await deliver(home, orbit, [update!]);
    expect(result.rejected).toEqual([]);
    expect(areFriends(home, ALICE, userIdOf(home, BOB))).toBe(true);
  });

  it('friend_add arriving before friend_request_update forms it', async () => {
    await aliceRequestsBob();
    const events = await bobAccepts();
    const result = await deliver(home, orbit, [...events].reverse());
    expect(result.rejected).toEqual([]);
    expect(areFriends(home, ALICE, userIdOf(home, BOB))).toBe(true);
    expect(home.db.select().from(schema.friends).all()).toHaveLength(1);
  });

  it('a friend_add for a friendship that already exists is accepted without effect', async () => {
    await aliceRequestsBob();
    const events = await bobAccepts();
    await deliver(home, orbit, events);

    const again = await deliver(home, orbit, [friendAdd('friend:again', ALICE, HOME)]);
    expect(again.accepted).toEqual(['friend:again']);
    expect(home.db.select().from(schema.friends).all()).toHaveLength(1);
  });
});

describe('a friend_add without the requester\'s pending request changes nothing', () => {
  it('is refused when our user never sent the other user a request', async () => {
    const result = await deliver(home, orbit, [friendAdd('friend:unrequested', ALICE, HOME)]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ messageId: 'friend:unrequested', reason: 'invalid_target' }]);
    expect(home.db.select().from(schema.friends).all()).toHaveLength(0);
    // Nothing is created for the other user either.
    expect(userIdOf(home, BOB)).toBeUndefined();
  });

  it('is refused when the only pending request runs from the other user to ours', async () => {
    // bob asks alice; home.test holds bob -> alice, pending.
    use(orbit, BOB);
    const res = await (await appOf(orbit)).inject({ method: 'POST', url: '/api/social/requests', payload: { username: 'alice@home.test' } });
    expect(res.statusCode).toBe(201);
    await deliver(home, orbit, takeOutbox(orbit, ['friend_request_create']));
    const incoming = home.db.select().from(schema.friendRequests).where(eq(schema.friendRequests.toId, ALICE)).get();
    expect(incoming?.status).toBe('pending');

    const result = await deliver(home, orbit, [friendAdd('friend:reverse', ALICE, HOME)]);
    expect(result.rejected).toEqual([{ messageId: 'friend:reverse', reason: 'invalid_target' }]);
    expect(home.db.select().from(schema.friends).all()).toHaveLength(0);
    // alice's decision on bob's request is still hers to make.
    expect(home.db.select().from(schema.friendRequests).where(eq(schema.friendRequests.id, incoming!.id)).get()?.status).toBe('pending');
  });

  it('is refused after our user removed the friend: the answered request is not asked again', async () => {
    await aliceRequestsBob();
    const events = await bobAccepts();
    await deliver(home, orbit, events);
    const bobOnHome = userIdOf(home, BOB)!;

    use(home, ALICE);
    const removed = await (await appOf(home)).inject({ method: 'DELETE', url: `/api/social/friends/${bobOnHome}` });
    expect(removed.statusCode).toBe(200);
    expect(areFriends(home, ALICE, bobOnHome)).toBe(false);

    const replay = events.find(e => e.eventType === 'friend_add')!;
    const replayed = await deliver(home, orbit, [replay, friendAdd('friend:later', ALICE, HOME)]);
    expect(replayed.accepted).toEqual([]);
    // The replay was applied once already: the applied-event ledger answers it
    // `duplicate` (#255). A new friend_add finds no pending request.
    expect(replayed.rejected.map(r => r.reason)).toEqual(['duplicate', 'invalid_target']);
    expect(areFriends(home, ALICE, bobOnHome)).toBe(false);
  });

  it('a friend_request_update (accepted) without our user\'s pending request forms nothing', async () => {
    const update: FederationRelayEvent = {
      ...friendAdd('friend_req:unrequested', ALICE, HOME),
      eventType: 'friend_request_update',
      friendship: { ...friendAdd('x', ALICE, HOME).friendship!, status: 'accepted' },
    };
    const result = await deliver(home, orbit, [update]);
    expect(result.rejected).toEqual([]);
    expect(home.db.select().from(schema.friends).all()).toHaveLength(0);
  });
});

describe('friend_request_update is applied to the users that are its identities here, found by pair', () => {
  it('an accepted update naming our requester\'s id on another domain forms nothing, and the request stays for the friend_add', async () => {
    await aliceRequestsBob();
    const events = await bobAccepts();
    const update = events.find(e => e.eventType === 'friend_request_update')!;
    const elsewhere: FederationRelayEvent = {
      ...update,
      messageId: `${update.messageId}:elsewhere`,
      friendship: { ...update.friendship!, from: { homeUserId: ALICE, homeInstance: 'https://elsewhere.test' } },
    };

    const result = await deliver(home, orbit, [elsewhere]);
    expect(result.rejected).toEqual([{ messageId: elsewhere.messageId, reason: 'sender_not_found' }]);
    expect(home.db.select().from(schema.friends).all()).toHaveLength(0);
    expect(home.db.select().from(schema.friendRequests).where(eq(schema.friendRequests.fromId, ALICE)).get()?.status).toBe('pending');

    const add = await deliver(home, orbit, [events.find(e => e.eventType === 'friend_add')!]);
    expect(add.rejected).toEqual([]);
    expect(areFriends(home, ALICE, userIdOf(home, BOB))).toBe(true);
  });

  it('a replicated row carrying our requester\'s id does not receive the acceptance of our requester\'s request', async () => {
    await aliceRequestsBob();
    const bobOnHome = userIdOf(home, BOB)!;
    // An older replicated row from another instance whose home id equals
    // alice's id, with its own pending request to bob.
    home.db.insert(schema.users).values({
      id: 'legacy-row', username: 'someone@d.test', passwordHash: '!federation-replicated', status: 'offline',
      isAdmin: 0, createdAt: Date.now(), homeUserId: ALICE, homeInstance: 'd.test',
    }).run();
    home.db.insert(schema.friendRequests).values({
      id: 'legacy-request', fromId: 'legacy-row', toId: bobOnHome, status: 'pending', createdAt: Date.now(),
    }).run();

    const [update] = await bobAccepts();
    const result = await deliver(home, orbit, [update!]);
    expect(result.rejected).toEqual([]);
    expect(areFriends(home, ALICE, bobOnHome)).toBe(true);
    expect(areFriends(home, 'legacy-row', bobOnHome)).toBe(false);
    expect(home.db.select().from(schema.friendRequests).where(eq(schema.friendRequests.id, 'legacy-request')).get()?.status).toBe('pending');
  });

  it('an update for a recipient this instance does not hold is accepted without effect and creates nobody', async () => {
    await aliceRequestsBob();
    const [update] = await bobAccepts();
    const stranger: FederationRelayEvent = {
      ...update!,
      messageId: `${update!.messageId}:stranger`,
      friendship: {
        ...update!.friendship!,
        to: { homeUserId: 'carol-id', homeInstance: ORBIT },
        toProfile: { username: 'carol', displayName: 'Carol', avatar: null, avatarColor: null, banner: null, bio: null, status: null },
      },
    };
    const result = await deliver(home, orbit, [stranger]);
    expect(result.accepted).toEqual([stranger.messageId]);
    expect(userIdOf(home, 'carol-id')).toBeUndefined();
    expect(home.db.select().from(schema.friends).all()).toHaveLength(0);
    expect(home.db.select().from(schema.friendRequests).where(eq(schema.friendRequests.fromId, ALICE)).get()?.status).toBe('pending');
  });
});

describe('the WS event of a relayed friendship goes to the side that is homed here, compared by identity', () => {
  function wsRecipients(type: string): string[] {
    return vi.mocked(connectionManager.sendToUser).mock.calls
      .filter(([, event]) => (event as { type: string }).type === type)
      .map(([uid]) => uid);
  }

  beforeEach(() => {
    vi.mocked(connectionManager.sendToUser).mockClear();
  });

  it('friend_add first: our requester gets friend_request_accepted when the peer names our domain without a scheme', async () => {
    await aliceRequestsBob();
    const events = await bobAccepts();
    const add = events.find(e => e.eventType === 'friend_add')!;
    const bare: FederationRelayEvent = {
      ...add,
      friendship: { ...add.friendship!, from: { homeUserId: ALICE, homeInstance: 'home.test' } },
    };
    vi.mocked(connectionManager.sendToUser).mockClear();

    const result = await deliver(home, orbit, [bare]);
    expect(result.rejected).toEqual([]);
    expect(wsRecipients('friend_request_accepted')).toEqual([ALICE]);
  });

  it('friend_add first: the same with the full origin', async () => {
    await aliceRequestsBob();
    const events = await bobAccepts();
    const add = events.find(e => e.eventType === 'friend_add')!;
    const full: FederationRelayEvent = {
      ...add,
      friendship: { ...add.friendship!, from: { homeUserId: ALICE, homeInstance: HOME } },
    };
    vi.mocked(connectionManager.sendToUser).mockClear();

    await deliver(home, orbit, [full]);
    expect(wsRecipients('friend_request_accepted')).toEqual([ALICE]);
  });

  it('friend_remove naming our user as `from` without a scheme tells our user', async () => {
    await aliceRequestsBob();
    await deliver(home, orbit, await bobAccepts());
    const bobOnHome = userIdOf(home, BOB)!;
    vi.mocked(connectionManager.sendToUser).mockClear();

    const remove: FederationRelayEvent = {
      eventType: 'friend_remove',
      contextType: 'friend',
      messageId: 'friend:remove-bare',
      encryptionVersion: 0,
      timestamp: Date.now(),
      friendship: {
        from: { homeUserId: ALICE, homeInstance: 'home.test' },
        to: { homeUserId: BOB, homeInstance: ORBIT },
        createdAt: Date.now(),
      },
    };
    const result = await deliver(home, orbit, [remove]);
    expect(result.rejected).toEqual([]);
    expect(areFriends(home, ALICE, bobOnHome)).toBe(false);
    const sent = vi.mocked(connectionManager.sendToUser).mock.calls
      .filter(([, event]) => (event as { type: string }).type === 'friend_removed');
    expect(sent).toEqual([[ALICE, { type: 'friend_removed', userId: bobOnHome }]]);
  });
});
