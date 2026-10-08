import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let testDb: TestDb;
let sqlite: Database.Database;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('../utils/federationAuth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationAuth.js')>('../utils/federationAuth.js');
  return {
    ...actual,
    getOurOrigin: () => 'https://local.example',
    buildFederationHeaders: () => ({}),
  };
});

// The relay is observed at the HTTP layer (see events.groupDmCall.test.ts).
const fetchMock = vi.fn();
vi.mock('../utils/federationFetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationFetch.js')>('../utils/federationFetch.js');
  return {
    ...actual,
    federationFetch: (...args: unknown[]) => fetchMock(...args),
  };
});

import { connectionManager } from './handler.js';
import type { FederatedCallEntry } from './handler.js';
import {
  handleDmCallStartForTest as start,
  handleDmCallAcceptForTest as accept,
  handleDmCallEndForTest as end,
  handleClientEvent,
  registerCallRelayHooks,
} from './events.js';
import { processDmCallAcceptEvent, processDmCallEndEvent } from '../routes/federation/events/calls.js';
import type { FederationRelayEvent } from '@backspace/shared';

const HERE = 'https://local.example';
const PEER = 'https://peer.example';
const PEER2 = 'https://peer2.example';

/** A group hosted here: alice and bob here, dave on PEER, frank on PEER2. */
const GROUP = 'dm-three-homes';
const GROUP_FID = '5c0b6a2e-1d3f-4e5a-8b7c-9d0e1f2a3b4c';
/** A 1-on-1 between grace, a federated account homed on PEER2 that uses this instance, and dave on PEER. */
const PAIR = 'dm-grace-dave';
const PAIR_FID = 'fedcba9876543210fedcba9876543210';
/** A 1-on-1 between grace (homed on PEER2, using this instance) and heidi on PEER. */
const GRACE_PEER_PAIR = 'dm-grace-heidi';
const GRACE_PEER_PAIR_FID = '00112233445566778899aabbccddeeff';
/** A group hosted on PEER that bob is in through this instance. */
const REMOTE_GROUP = 'dm-remote-group';
const REMOTE_FID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const VOICE_CHANNEL = 'voice-1';

const DAVE = { homeUserId: 'dave-home', homeInstance: PEER };
const FRANK = { homeUserId: 'frank-home', homeInstance: PEER2 };
const GRACE = { homeUserId: 'grace-home', homeInstance: PEER2 };
const HEIDI = { homeUserId: 'heidi-home', homeInstance: PEER };

interface Sent { type: string; [key: string]: unknown }

const sockets = new Map<string, WebSocket[]>();

function connect(userId: string): WebSocket {
  const s = { readyState: 1, send: vi.fn() } as unknown as WebSocket;
  connectionManager.addConnection(userId, s);
  sockets.set(userId, [...(sockets.get(userId) ?? []), s]);
  return s;
}

function ws(userId: string): WebSocket {
  const list = sockets.get(userId);
  if (!list || list.length === 0) throw new Error(`no socket for ${userId}`);
  return list[0]!;
}

function received(userId: string, type: string): Sent[] {
  return (sockets.get(userId) ?? [])
    .flatMap(s => (s.send as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([raw]) => JSON.parse(raw as string) as Sent))
    .filter(e => e.type === type);
}

/** The relay events posted to `origin`, in order. */
function relayedTo(origin: string): FederationRelayEvent[] {
  return fetchMock.mock.calls
    .filter(([target]) => target === origin)
    .flatMap(([, , init]) => (JSON.parse((init as { body: string }).body) as { events: FederationRelayEvent[] }).events);
}

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

function seedUser(id: string, home?: { homeUserId: string; homeInstance: string }): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    passwordHash: '!test',
    homeUserId: home?.homeUserId ?? null,
    homeInstance: home?.homeInstance ?? null,
    createdAt: Date.now(),
  }).run();
}

function seedDm(id: string, ownerId: string | null, federatedId: string | null, members: string[]): void {
  testDb.insert(schema.dmChannels).values({ id, ownerId, federatedId, createdAt: Date.now() }).run();
  testDb.insert(schema.dmMembers).values(members.map(userId => ({ dmChannelId: id, userId }))).run();
}

function relayed(
  process: typeof processDmCallEndEvent,
  eventType: 'dm_call_accept' | 'dm_call_end',
  actor: { homeUserId: string; homeInstance: string },
  federatedId: string,
  perMember?: boolean,
): void {
  const call = eventType === 'dm_call_accept'
    ? { acceptor: actor, ...(perMember ? { perMember: true } : {}) }
    : { endedBy: actor, ...(perMember ? { perMember: true } : {}) };
  process({
    eventType,
    messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
    encryptionVersion: 0,
    timestamp: Date.now(),
    federatedId,
    call,
  }, PEER, testDb, [], []);
}

function remoteCall(partial: Partial<FederatedCallEntry> = {}): FederatedCallEntry {
  return {
    dmChannelId: REMOTE_GROUP,
    federatedId: REMOTE_FID,
    callerId: 'dave-stub',
    callerHomeUserId: DAVE.homeUserId,
    federatedCallHost: PEER,
    livekitUrl: 'wss://peer.example/lk',
    tokens: new Map([['bob', 'tok-b'], ['alice', 'tok-a']]),
    ringedUserIds: ['bob', 'alice'],
    joinedUserIds: [],
    group: true,
    state: 'ringing',
    startedAt: Date.now(),
    ...partial,
  };
}

/** Let the fire-and-forget fan-out promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeAll(() => {
  registerCallRelayHooks();
});

beforeEach(() => {
  vi.useFakeTimers();
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ accepted: [], rejected: [] }), { status: 200 }));
  for (const [id, origin, name] of [['peer-1', PEER, 'Peer'], ['peer-2', PEER2, 'Peer 2']] as const) {
    testDb.insert(schema.federationPeers).values({
      id, origin, hmacSecret: 'secret', status: 'active', instanceName: name, lastSyncedAt: 0, createdAt: Date.now(),
    }).run();
  }

  seedUser('alice');
  seedUser('bob');
  seedUser('dave-stub', DAVE);
  seedUser('frank-stub', FRANK);
  seedUser('grace', GRACE);
  seedUser('heidi-stub', HEIDI);
  seedDm(GROUP, 'alice', GROUP_FID, ['alice', 'bob', 'dave-stub', 'frank-stub']);
  seedDm(PAIR, null, PAIR_FID, ['grace', 'dave-stub']);
  seedDm(GRACE_PEER_PAIR, null, GRACE_PEER_PAIR_FID, ['grace', 'heidi-stub']);
  seedDm(REMOTE_GROUP, 'dave-stub', REMOTE_FID, ['dave-stub', 'alice', 'bob']);
  testDb.insert(schema.spaces).values({ id: 'space-1', name: 'Space', ownerId: 'bob', createdAt: Date.now() }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: 'space-1', userId: 'bob', joinedAt: Date.now() }).run();
  testDb.insert(schema.channels).values({ id: VOICE_CHANNEL, spaceId: 'space-1', name: 'Voice', type: 'voice', createdAt: Date.now() }).run();

  for (const id of ['alice', 'bob', 'grace']) connect(id);
});

afterEach(() => {
  for (const roomId of [GROUP, PAIR, GRACE_PEER_PAIR, REMOTE_GROUP, VOICE_CHANNEL]) connectionManager.destroyRoom(roomId);
  for (const [fedId] of Array.from(connectionManager.getAllFederatedCalls())) connectionManager.clearFederatedCall(fedId);
  for (const [userId, list] of sockets) {
    connectionManager.clearVoiceWs(userId);
    for (const s of list) connectionManager.removeConnection(s);
  }
  sockets.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sqlite.close();
});

describe('a ringing call its caller leaves behind', () => {
  it('ends, and the end reaches the peers, when the caller starts another call', async () => {
    connectionManager.createDmRoom(GROUP, 'alice');
    connectionManager.setVoiceWs('alice', ws('alice'));

    await start({ dmChannelId: REMOTE_GROUP }, 'alice', 'alice', ws('alice'));
    await settle();

    expect(connectionManager.getRoom(GROUP)).toBeUndefined();
    expect(received('bob', 'dm_call_ended')).toEqual([expect.objectContaining({ dmChannelId: GROUP })]);
    for (const peer of [PEER, PEER2]) {
      expect(relayedTo(peer)).toContainEqual(expect.objectContaining({
        eventType: 'dm_call_end',
        federatedId: GROUP_FID,
        call: { endedBy: { homeUserId: 'alice', homeInstance: HERE } },
      }));
    }
  });

  it('ends, and the end reaches the peers, when the caller joins a voice channel, which keeps its session', async () => {
    connectionManager.createDmRoom(GROUP, 'bob');
    connectionManager.setVoiceWs('bob', ws('bob'));

    handleClientEvent({ type: 'voice_join', channelId: VOICE_CHANNEL }, 'bob', 'bob', ws('bob'), false);
    await settle();

    expect(connectionManager.getRoom(GROUP)).toBeUndefined();
    expect(received('alice', 'dm_call_ended')).toEqual([expect.objectContaining({ dmChannelId: GROUP })]);
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({ eventType: 'dm_call_end', federatedId: GROUP_FID })]);
    expect(connectionManager.getUserRoom('bob')?.roomId).toBe(VOICE_CHANNEL);
    expect(connectionManager.getVoiceWs('bob')).toBe(ws('bob'));
  });
});

describe('who a relay from the host names', () => {
  it('names the caller, not the remote acceptor, when it passes an accept on to a third instance', async () => {
    connectionManager.createDmRoom(GROUP, 'alice');
    connectionManager.setVoiceWs('alice', ws('alice'));

    relayed(processDmCallAcceptEvent, 'dm_call_accept', DAVE, GROUP_FID, true);
    await settle();

    expect(relayedTo(PEER)).toEqual([]);
    // The accept is named after the caller, and says who answered.
    expect(relayedTo(PEER2)).toEqual([expect.objectContaining({
      eventType: 'dm_call_accept',
      federatedId: GROUP_FID,
      call: { acceptor: { homeUserId: 'alice', homeInstance: HERE }, answeredBy: DAVE },
    })]);
  });

  it('names a member coming home, not the remote member, when it passes a 1-on-1 end on', async () => {
    // grace is homed on PEER2 and uses this instance; dave on PEER ends.
    connectionManager.createDmRoom(PAIR, 'grace');
    connectionManager.setVoiceWs('grace', ws('grace'));
    relayed(processDmCallAcceptEvent, 'dm_call_accept', DAVE, PAIR_FID);
    await settle();
    fetchMock.mockClear();

    relayed(processDmCallEndEvent, 'dm_call_end', DAVE, PAIR_FID);
    await settle();

    expect(connectionManager.getRoom(PAIR)).toBeUndefined();
    expect(relayedTo(PEER)).toEqual([]);
    expect(relayedTo(PEER2)).toEqual([expect.objectContaining({
      eventType: 'dm_call_end',
      federatedId: PAIR_FID,
      call: { endedBy: GRACE },
    })]);
  });

  it('names a federated account by its home, and tells nothing to a peer that accepts no name for the call', async () => {
    // grace (homed on PEER2) is in a call with heidi (on PEER) hosted here,
    // and hangs up.
    connectionManager.createDmRoom(GRACE_PEER_PAIR, 'grace');
    connectionManager.setVoiceWs('grace', ws('grace'));

    await end({ dmChannelId: GRACE_PEER_PAIR }, 'grace');
    await settle();

    // PEER2 is grace's home, so it is told in her name. PEER accepts from
    // here only an actor homed here or on PEER, and nobody in this call is:
    // it refuses her own identity as it refused this instance's address for
    // her at the start, so the start never went there and the end does not
    // either (the start test is in events.callStartTokenScoping.test.ts).
    expect(relayedTo(PEER2)).toEqual([expect.objectContaining({
      eventType: 'dm_call_end',
      federatedId: GRACE_PEER_PAIR_FID,
      call: { endedBy: GRACE },
    })]);
    expect(relayedTo(PEER)).toEqual([]);
  });

  it('names a member homed here by this instance', async () => {
    connectionManager.createDmRoom(GROUP, 'alice');
    connectionManager.setVoiceWs('alice', ws('alice'));

    await end({ dmChannelId: GROUP }, 'alice');
    await settle();

    expect(relayedTo(PEER2)).toEqual([expect.objectContaining({
      eventType: 'dm_call_end',
      call: { endedBy: { homeUserId: 'alice', homeInstance: HERE } },
    })]);
  });

  it('sends no accept a host would refuse, and tells the member the accept did not go through', async () => {
    // A host rings a member only through their home, so it does not hand
    // this instance a call for grace, whose home is PEER2. Were it held here
    // anyway, the host (PEER) would refuse any name for her from here.
    connectionManager.createFederatedCall(remoteCall({
      dmChannelId: PAIR,
      federatedId: PAIR_FID,
      federatedCallHost: PEER,
      tokens: new Map([['grace', 'tok-g']]),
      ringedUserIds: ['grace'],
      group: false,
    }));
    await accept({ federatedCallId: PAIR_FID }, 'grace', ws('grace'));
    await settle();

    expect(relayedTo(PEER)).toEqual([]);
    expect(received('grace', 'dm_call_undeliverable')).toEqual([expect.objectContaining({
      phase: 'accept',
      terminal: true,
      failures: [expect.objectContaining({ reason: 'identity_not_accepted' })],
    })]);
  });

  it('relays the accept of a member homed here in their name, saying they answered', async () => {
    connectionManager.createFederatedCall(remoteCall({ group: false }));
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    await settle();

    const bob = { homeUserId: 'bob', homeInstance: HERE };
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_accept',
      call: { acceptor: bob, answeredBy: bob },
    })]);
  });
});

describe('who answered a call', () => {
  // dm_call_accepted names the member who answered, so a group's other
  // members keep ringing and only the answering member's other sessions stop.
  const ALICE = { homeUserId: 'alice', homeInstance: HERE };
  const BOB = { homeUserId: 'bob', homeInstance: HERE };

  it('names the member who joined a call hosted here, to the members here and to the peers', async () => {
    connectionManager.createDmRoom(GROUP, 'alice');
    connectionManager.setVoiceWs('alice', ws('alice'));

    await accept({ dmChannelId: GROUP }, 'bob', ws('bob'));
    await settle();

    expect(received('alice', 'dm_call_accepted')).toEqual([expect.objectContaining({ dmChannelId: GROUP, answeredBy: BOB })]);
    for (const peer of [PEER, PEER2]) {
      expect(relayedTo(peer)).toEqual([expect.objectContaining({
        eventType: 'dm_call_accept',
        call: { acceptor: BOB, answeredBy: BOB },
      })]);
    }
  });

  it('names the remote member whose relayed accept reached the host, though the fan-out is named after the caller', async () => {
    connectionManager.createDmRoom(GROUP, 'alice');
    connectionManager.setVoiceWs('alice', ws('alice'));

    relayed(processDmCallAcceptEvent, 'dm_call_accept', DAVE, GROUP_FID, true);
    await settle();

    expect(received('bob', 'dm_call_accepted')).toEqual([expect.objectContaining({ answeredBy: DAVE })]);
    expect(relayedTo(PEER2)).toEqual([expect.objectContaining({
      call: { acceptor: ALICE, answeredBy: DAVE },
    })]);
  });

  it('names the member who answered a call hosted on a peer, here and to the host', async () => {
    connectionManager.createFederatedCall(remoteCall());

    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    await settle();

    expect(received('alice', 'dm_call_accepted')).toEqual([expect.objectContaining({ federatedCallId: REMOTE_FID, answeredBy: BOB })]);
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      call: expect.objectContaining({ acceptor: BOB, answeredBy: BOB }),
    })]);
  });

  it('passes on whom the host names as having answered', () => {
    connectionManager.createFederatedCall(remoteCall());

    processDmCallAcceptEvent({
      eventType: 'dm_call_accept',
      messageId: 'msg-answered',
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: REMOTE_FID,
      call: { acceptor: DAVE, answeredBy: FRANK },
    }, PEER, testDb, [], []);

    expect(received('alice', 'dm_call_accepted')).toEqual([expect.objectContaining({ answeredBy: FRANK })]);
  });

  it('takes the acceptor as who answered from a host up to 1.9.0, which does not say', () => {
    connectionManager.createFederatedCall(remoteCall());

    relayed(processDmCallAcceptEvent, 'dm_call_accept', DAVE, REMOTE_FID);

    expect(received('bob', 'dm_call_accepted')).toEqual([expect.objectContaining({ answeredBy: DAVE })]);
  });
});

describe('a member who joins voice on another instance', () => {
  it('leaves the call hosted on a peer with a voice_leave here, and the host is told', async () => {
    connectionManager.createFederatedCall(remoteCall());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    await settle();
    fetchMock.mockClear();

    handleClientEvent({ type: 'voice_leave' }, 'bob', 'bob', ws('bob'), false);
    await settle();

    expect(connectionManager.getJoinedFederatedCall('bob')).toBeUndefined();
    expect(connectionManager.getVoiceWs('bob')).toBeUndefined();
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_end',
      federatedId: REMOTE_FID,
      call: { endedBy: { homeUserId: 'bob', homeInstance: HERE }, perMember: true },
    })]);
  });
});

describe('the record of a call hosted on a peer', () => {
  it('stays while its ring window is open, so a member here can still answer', async () => {
    connectionManager.createFederatedCall(remoteCall());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    await end({ federatedCallId: REMOTE_FID }, 'bob');

    expect(connectionManager.getFederatedCall(REMOTE_FID)).toBeDefined();

    vi.advanceTimersByTime(60_000);

    expect(connectionManager.getFederatedCall(REMOTE_FID)).toBeUndefined();
  });

  it('goes as soon as its last member here leaves once the ring window has closed', async () => {
    connectionManager.createFederatedCall(remoteCall());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    vi.advanceTimersByTime(60_000);
    expect(connectionManager.getFederatedCall(REMOTE_FID)?.joinedUserIds).toEqual(['bob']);

    await end({ federatedCallId: REMOTE_FID }, 'bob');

    expect(connectionManager.getFederatedCall(REMOTE_FID)).toBeUndefined();
  });

  it('is dropped without telling anyone, since nobody here holds the call', async () => {
    connectionManager.createFederatedCall(remoteCall());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    await end({ federatedCallId: REMOTE_FID }, 'bob');
    const before = received('alice', 'dm_call_ended').length;

    vi.advanceTimersByTime(60_000);

    expect(received('alice', 'dm_call_ended')).toHaveLength(before);
    expect(received('bob', 'dm_call_ended')).toHaveLength(0);
  });

  it('still ends a call nobody answered when the ring window closes', () => {
    connectionManager.createFederatedCall(remoteCall());

    vi.advanceTimersByTime(60_000);

    expect(connectionManager.getFederatedCall(REMOTE_FID)).toBeUndefined();
    expect(received('bob', 'dm_call_ended')).toEqual([expect.objectContaining({ federatedCallId: REMOTE_FID })]);
  });
});
