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

// The relay is observed at the HTTP layer: `sendCallRelay` is reached both
// from ws/events.ts and from the federation route module, which an import
// cycle loads before a module mock of federationOutbox could apply.
const fetchMock = vi.fn();
vi.mock('../utils/federationFetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationFetch.js')>('../utils/federationFetch.js');
  return {
    ...actual,
    federationFetch: (...args: unknown[]) => fetchMock(...args),
  };
});

import { connectionManager, buildReadyPayload, VOICE_RECONNECT_GRACE_MS } from './handler.js';
import type { FederatedCallEntry } from './handler.js';
import {
  handleDmCallStartForTest as start,
  handleDmCallAcceptForTest as accept,
  handleDmCallRejectForTest as reject,
  handleDmCallEndForTest as end,
  handleClientEvent,
  registerCallRelayHooks,
} from './events.js';
import {
  processDmCallAcceptEvent,
  processDmCallEndEvent,
  processDmCallRejectEvent,
  processDmCallStartEvent,
} from '../routes/federation/events/calls.js';
import type { FederationRelayEvent } from '@backspace/shared';

/** The relay events posted to `origin`, in order. */
function relayedTo(origin: string): FederationRelayEvent[] {
  return fetchMock.mock.calls
    .filter(([target]) => target === origin)
    .flatMap(([, , init]) => (JSON.parse((init as { body: string }).body) as { events: FederationRelayEvent[] }).events);
}

const GROUP = 'dm-group';
const ONE_ON_ONE = 'dm-pair';
const FED_GROUP = 'dm-fed-group';
const FED_GROUP_FID = '0b9f4c52-3a51-4c0e-9a8e-5d2f8b6c7e10';
const PEER = 'https://peer.example';
/** A second group hosted here with a member on the peer. */
const FED_GROUP_2 = 'dm-fed-group-2';
const FED_GROUP_2_FID = '4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
/** A 1-on-1 hosted here with the peer's member. */
const PAIR_FED = 'dm-pair-fed';
const PAIR_FED_FID = '0123456789abcdef0123456789abcdef';
/** A space voice channel here, in a space bob owns. */
const VOICE_CHANNEL = 'voice-1';
/** The key of a group call hosted on the peer; GROUP has no key here, as on an instance that never relayed it. */
const REMOTE_FID = '7d3e2f10-8c4b-4a6e-b1d2-93f0a5c4e821';

interface Sent { type: string; [key: string]: unknown }

const sockets = new Map<string, WebSocket[]>();

function socket(): WebSocket {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

/** Connect a socket for `userId`; the first one is the user's main socket. */
function connect(userId: string): WebSocket {
  const ws = socket();
  connectionManager.addConnection(userId, ws);
  sockets.set(userId, [...(sockets.get(userId) ?? []), ws]);
  return ws;
}

function ws(userId: string): WebSocket {
  const list = sockets.get(userId);
  if (!list || list.length === 0) throw new Error(`no socket for ${userId}`);
  return list[0]!;
}

function sentOn(target: WebSocket): Sent[] {
  return (target.send as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map(([raw]) => JSON.parse(raw as string) as Sent);
}

function received(userId: string, type?: string): Sent[] {
  const events = (sockets.get(userId) ?? []).flatMap(sentOn);
  return type ? events.filter(e => e.type === type) : events;
}

function clearReceived(): void {
  for (const list of sockets.values()) {
    for (const s of list) (s.send as unknown as ReturnType<typeof vi.fn>).mockClear();
  }
}

function participants(dmChannelId: string): string[] {
  return Array.from(connectionManager.getRoomParticipants(dmChannelId)).sort();
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

/**
 * A relayed call event from PEER. `perMember` marks a sender of this version
 * applying the group rules (an accept it will relay the leave of, an end or
 * decline of that member only); a peer up to 1.8.0 omits it.
 */
function relay(
  eventType: 'dm_call_accept' | 'dm_call_reject' | 'dm_call_end',
  actor: { homeUserId: string; homeInstance: string },
  perMember?: boolean,
  federatedId: string = FED_GROUP_FID,
): FederationRelayEvent {
  const flag = perMember ? { perMember: true } : {};
  const call = eventType === 'dm_call_accept' ? { acceptor: actor, ...flag }
    : eventType === 'dm_call_reject' ? { rejector: actor, ...flag }
      : { endedBy: actor, ...flag };
  return {
    eventType,
    messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
    encryptionVersion: 0,
    timestamp: Date.now(),
    federatedId,
    call,
  };
}

const DAVE = { homeUserId: 'dave-home', homeInstance: PEER };
const ERIN = { homeUserId: 'erin-home', homeInstance: PEER };

function relayedFrom(process: typeof processDmCallEndEvent, event: FederationRelayEvent): { accepted: string[]; rejected: Array<{ messageId: string; reason: string }> } {
  const accepted: string[] = [];
  const rejected: Array<{ messageId: string; reason: string }> = [];
  process(event, PEER, testDb, accepted, rejected);
  return { accepted, rejected };
}

/** Let the fire-and-forget fan-out promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeAll(() => {
  // The ConnectionManager relays the ends it makes itself through this hook.
  registerCallRelayHooks();
});

beforeEach(() => {
  vi.useFakeTimers();
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ accepted: [], rejected: [] }), { status: 200 }));
  testDb.insert(schema.federationPeers).values({
    id: 'peer-1', origin: PEER, hmacSecret: 'secret', status: 'active', instanceName: 'Peer', lastSyncedAt: 0, createdAt: Date.now(),
  }).run();

  for (const id of ['alice', 'bob', 'carol']) seedUser(id);
  seedUser('dave-stub', DAVE);
  seedUser('erin-stub', ERIN);
  seedDm(GROUP, 'alice', null, ['alice', 'bob', 'carol']);
  seedDm(ONE_ON_ONE, null, null, ['alice', 'bob']);
  seedDm(FED_GROUP, 'alice', FED_GROUP_FID, ['alice', 'bob', 'dave-stub', 'erin-stub']);
  seedDm(FED_GROUP_2, 'alice', FED_GROUP_2_FID, ['alice', 'dave-stub']);
  seedDm(PAIR_FED, null, PAIR_FED_FID, ['alice', 'dave-stub']);
  testDb.insert(schema.spaces).values({ id: 'space-1', name: 'Space', ownerId: 'bob', createdAt: Date.now() }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: 'space-1', userId: 'bob', joinedAt: Date.now() }).run();
  testDb.insert(schema.channels).values({ id: VOICE_CHANNEL, spaceId: 'space-1', name: 'Voice', type: 'voice', createdAt: Date.now() }).run();

  for (const id of ['alice', 'bob', 'carol']) connect(id);
});

afterEach(() => {
  for (const roomId of [GROUP, ONE_ON_ONE, FED_GROUP, FED_GROUP_2, PAIR_FED, VOICE_CHANNEL]) connectionManager.destroyRoom(roomId);
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

describe('starting a call in a DM that already has one', () => {
  it('joins a running group call instead of starting a second one', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    await accept({ dmChannelId: GROUP }, 'bob', ws('bob'));
    clearReceived();

    await start({ dmChannelId: GROUP }, 'carol', 'carol', ws('carol'));

    expect(participants(GROUP)).toEqual(['alice', 'bob', 'carol']);
    expect(received('carol', 'error')).toEqual([]);
    expect(received('carol', 'dm_call_accepted')).toHaveLength(1);
    expect(received('bob', 'dm_call_incoming')).toEqual([]);
  });

  it('joins a ringing call, which turns it active with the caller seated', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));

    await start({ dmChannelId: GROUP }, 'carol', 'carol', ws('carol'));

    const room = connectionManager.getRoom(GROUP);
    expect(room?.metadata).toMatchObject({ state: 'active', callerId: 'alice' });
    expect(participants(GROUP)).toEqual(['alice', 'carol']);
  });

  it('refuses a member already in the call with a code, on the sending socket only', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    const secondTab = connect('alice');
    clearReceived();

    await start({ dmChannelId: GROUP }, 'alice', 'alice', secondTab);

    expect(sentOn(secondTab)).toEqual([
      expect.objectContaining({ type: 'error', code: 'dm_call_in_progress', dmChannelId: GROUP }),
    ]);
    expect(sentOn(ws('alice'))).toEqual([]);
    expect(connectionManager.getRoom(GROUP)?.metadata).toMatchObject({ state: 'ringing', callerId: 'alice' });
  });

  it('refuses a start from a member of no such DM with a code', async () => {
    await start({ dmChannelId: ONE_ON_ONE }, 'carol', 'carol', ws('carol'));

    expect(received('carol', 'error')).toEqual([
      expect.objectContaining({ code: 'not_dm_member', dmChannelId: ONE_ON_ONE }),
    ]);
    expect(connectionManager.getRoom(ONE_ON_ONE)).toBeUndefined();
  });

  it('refuses a start in a DM whose call is hosted on another instance', async () => {
    const entry: FederatedCallEntry = {
      dmChannelId: GROUP,
      federatedId: 'fed-elsewhere',
      callerId: 'alice',
      callerHomeUserId: 'alice-home',
      federatedCallHost: PEER,
      livekitUrl: 'wss://peer.example/lk',
      tokens: new Map(),
      ringedUserIds: ['bob'],
      joinedUserIds: ['bob'],
      group: true,
      state: 'active',
      startedAt: Date.now(),
    };
    connectionManager.createFederatedCall(entry);

    await start({ dmChannelId: GROUP }, 'carol', 'carol', ws('carol'));

    expect(received('carol', 'error')).toEqual([
      expect.objectContaining({ code: 'dm_call_in_progress', dmChannelId: GROUP }),
    ]);
    expect(connectionManager.getRoom(GROUP)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('group call: end and decline', () => {
  it('ignores a cancel from a member who is not in the call', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    await accept({ dmChannelId: GROUP }, 'bob', ws('bob'));
    clearReceived();

    await end({ dmChannelId: GROUP }, 'carol');

    expect(participants(GROUP)).toEqual(['alice', 'bob']);
    expect(received('alice', 'dm_call_ended')).toEqual([]);
    expect(received('bob', 'dm_call_ended')).toEqual([]);
  });

  it('takes only the member who hangs up out of a call of three', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    await accept({ dmChannelId: GROUP }, 'bob', ws('bob'));
    await accept({ dmChannelId: GROUP }, 'carol', ws('carol'));
    clearReceived();

    await end({ dmChannelId: GROUP }, 'bob');

    expect(participants(GROUP)).toEqual(['alice', 'carol']);
    expect(received('alice', 'voice_state_update')).toEqual([
      expect.objectContaining({ channelId: GROUP, userId: 'bob', action: 'leave' }),
    ]);
    expect(received('alice', 'dm_call_ended')).toEqual([]);
    expect(received('carol', 'dm_call_ended')).toEqual([]);
  });

  it('stops only the decliner ringing while the call rings', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    clearReceived();

    await reject({ dmChannelId: GROUP }, 'bob');

    expect(connectionManager.getRoom(GROUP)?.metadata).toMatchObject({ state: 'ringing' });
    expect(received('bob', 'dm_call_rejected')).toHaveLength(1);
    expect(received('alice', 'dm_call_rejected')).toEqual([]);
    expect(received('carol', 'dm_call_rejected')).toEqual([]);

    await accept({ dmChannelId: GROUP }, 'carol', ws('carol'));
    expect(participants(GROUP)).toEqual(['alice', 'carol']);
  });

  it('stops only the decliner ringing once others have joined', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    await accept({ dmChannelId: GROUP }, 'bob', ws('bob'));
    clearReceived();

    await reject({ dmChannelId: GROUP }, 'carol');

    expect(participants(GROUP)).toEqual(['alice', 'bob']);
    expect(received('carol', 'dm_call_rejected')).toHaveLength(1);
    expect(received('alice', 'dm_call_rejected')).toEqual([]);
    expect(received('bob', 'dm_call_rejected')).toEqual([]);
  });

  it('ignores a decline from a member who is in the call', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    await accept({ dmChannelId: GROUP }, 'bob', ws('bob'));
    clearReceived();

    await reject({ dmChannelId: GROUP }, 'bob');

    expect(participants(GROUP)).toEqual(['alice', 'bob']);
    expect(received('bob', 'dm_call_rejected')).toEqual([]);
  });

  it('ends a ringing call once every member but the caller has declined', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    await reject({ dmChannelId: GROUP }, 'bob');
    clearReceived();

    await reject({ dmChannelId: GROUP }, 'carol');

    expect(connectionManager.getRoom(GROUP)).toBeUndefined();
    for (const id of ['alice', 'bob', 'carol']) {
      expect(received(id, 'dm_call_rejected')).toHaveLength(1);
    }
  });

  it('ends the call when its last participant leaves', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    await accept({ dmChannelId: GROUP }, 'bob', ws('bob'));
    await end({ dmChannelId: GROUP }, 'alice');
    expect(participants(GROUP)).toEqual(['bob']);
    clearReceived();

    await end({ dmChannelId: GROUP }, 'bob');

    expect(connectionManager.getRoom(GROUP)).toBeUndefined();
    for (const id of ['alice', 'bob', 'carol']) {
      expect(received(id, 'dm_call_ended')).toHaveLength(1);
    }
  });

  it('ends a call nobody joined when the caller cancels', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    clearReceived();

    await end({ dmChannelId: GROUP }, 'alice');

    expect(connectionManager.getRoom(GROUP)).toBeUndefined();
    expect(received('bob', 'dm_call_ended')).toHaveLength(1);
    expect(received('carol', 'dm_call_ended')).toHaveLength(1);
  });

  it('ends a call nobody joined when the ringing times out', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    await reject({ dmChannelId: GROUP }, 'bob');
    clearReceived();

    vi.advanceTimersByTime(60_000);

    expect(connectionManager.getRoom(GROUP)).toBeUndefined();
    expect(received('carol', 'dm_call_ended')).toHaveLength(1);
  });
});

describe('1-on-1 call keeps its semantics', () => {
  it('ends for both when one side hangs up', async () => {
    await start({ dmChannelId: ONE_ON_ONE }, 'alice', 'alice', ws('alice'));
    await accept({ dmChannelId: ONE_ON_ONE }, 'bob', ws('bob'));
    clearReceived();

    await end({ dmChannelId: ONE_ON_ONE }, 'bob');

    expect(connectionManager.getRoom(ONE_ON_ONE)).toBeUndefined();
    expect(received('alice', 'dm_call_ended')).toHaveLength(1);
    expect(received('bob', 'dm_call_ended')).toHaveLength(1);
  });

  it('ends for both when the callee declines', async () => {
    await start({ dmChannelId: ONE_ON_ONE }, 'alice', 'alice', ws('alice'));
    clearReceived();

    await reject({ dmChannelId: ONE_ON_ONE }, 'bob');

    expect(connectionManager.getRoom(ONE_ON_ONE)).toBeUndefined();
    expect(received('alice', 'dm_call_rejected')).toHaveLength(1);
    expect(received('bob', 'dm_call_rejected')).toHaveLength(1);
  });

  it('joins the call when the callee presses call while it rings', async () => {
    await start({ dmChannelId: ONE_ON_ONE }, 'alice', 'alice', ws('alice'));

    await start({ dmChannelId: ONE_ON_ONE }, 'bob', 'bob', ws('bob'));

    expect(participants(ONE_ON_ONE)).toEqual(['alice', 'bob']);
    expect(received('bob', 'error')).toEqual([]);
  });
});

describe('group call hosted here with members on a peer', () => {
  async function callWith(...remote: Array<typeof DAVE>): Promise<void> {
    connectionManager.createDmRoom(FED_GROUP, 'alice');
    connectionManager.setVoiceWs('alice', ws('alice'));
    for (const actor of remote) relayedFrom(processDmCallAcceptEvent, relay('dm_call_accept', actor, true));
    await settle();
  }

  it('seats a remote acceptor as a participant', async () => {
    await callWith(DAVE);
    expect(participants(FED_GROUP)).toEqual(['alice', 'dave-stub']);
  });

  it('keeps the call for the remote member when the local caller hangs up', async () => {
    await callWith(DAVE);
    fetchMock.mockClear();

    await end({ dmChannelId: FED_GROUP }, 'alice');

    expect(participants(FED_GROUP)).toEqual(['dave-stub']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes only the member who left out when the peer leaves others in', async () => {
    await callWith(DAVE, ERIN);
    clearReceived();

    const result = relayedFrom(processDmCallEndEvent, relay('dm_call_end', DAVE, true));
    await settle();

    expect(result.accepted).toHaveLength(1);
    expect(participants(FED_GROUP)).toEqual(['alice', 'erin-stub']);
    expect(received('bob', 'dm_call_ended')).toEqual([]);
  });

  it('ends the call for every peer, in the caller\'s name, when the last remote participant leaves', async () => {
    await callWith(DAVE);
    await end({ dmChannelId: FED_GROUP }, 'alice');
    clearReceived();
    fetchMock.mockClear();

    const result = relayedFrom(processDmCallEndEvent, relay('dm_call_end', DAVE, true));
    await settle();

    expect(result.rejected).toEqual([]);
    expect(connectionManager.getRoom(FED_GROUP)).toBeUndefined();
    expect(received('bob', 'dm_call_ended')).toHaveLength(1);
    // The sender is not excluded: its other members may still be ringing. The
    // end names a user homed here, which the peer accepts from this instance.
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_end',
      federatedId: FED_GROUP_FID,
      call: { endedBy: { homeUserId: 'alice', homeInstance: 'https://local.example' } },
    })]);
  });

  it('ignores a relayed end from a remote member who is not in the call', async () => {
    await callWith(DAVE);
    clearReceived();

    const result = relayedFrom(processDmCallEndEvent, relay('dm_call_end', ERIN, true));
    await settle();

    expect(result.accepted).toHaveLength(1);
    expect(participants(FED_GROUP)).toEqual(['alice', 'dave-stub']);
    expect(received('bob', 'dm_call_ended')).toEqual([]);
  });

  it('records a relayed decline without ending a call others are in', async () => {
    await callWith(DAVE);
    clearReceived();

    relayedFrom(processDmCallRejectEvent, relay('dm_call_reject', ERIN, true));
    await settle();

    expect(participants(FED_GROUP)).toEqual(['alice', 'dave-stub']);
    expect(received('alice', 'dm_call_rejected')).toEqual([]);
  });

  it('takes every participant a peer seated out when its end carries no perMember', async () => {
    // A sender that ends without perMember ends the call for all of its own
    // members, so none of the seats it holds here is still in the call.
    await callWith(DAVE, ERIN);
    clearReceived();

    relayedFrom(processDmCallEndEvent, relay('dm_call_end', DAVE));
    await settle();

    expect(participants(FED_GROUP)).toEqual(['alice']);
    expect(received('bob', 'dm_call_ended')).toEqual([]);
  });

  it('does not seat an acceptor from a 1.8.0 peer, which never relays that member\'s leave', async () => {
    connectionManager.createDmRoom(FED_GROUP, 'alice');
    connectionManager.setVoiceWs('alice', ws('alice'));

    relayedFrom(processDmCallAcceptEvent, relay('dm_call_accept', DAVE));
    await settle();

    expect(participants(FED_GROUP)).toEqual(['alice']);
    expect(connectionManager.getRoom(FED_GROUP)?.metadata).toMatchObject({ state: 'active' });
  });

  it('ends the call with its last member here when a 1.8.0 peer\'s member joined it', async () => {
    connectionManager.createDmRoom(FED_GROUP, 'alice');
    connectionManager.setVoiceWs('alice', ws('alice'));
    relayedFrom(processDmCallAcceptEvent, relay('dm_call_accept', DAVE));
    await settle();
    clearReceived();
    fetchMock.mockClear();

    await end({ dmChannelId: FED_GROUP }, 'alice');

    expect(connectionManager.getRoom(FED_GROUP)).toBeUndefined();
    expect(received('bob', 'dm_call_ended')).toHaveLength(1);
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({ eventType: 'dm_call_end', federatedId: FED_GROUP_FID })]);
  });

  it('keeps the call for the members here on a 1.8.0 peer\'s end or decline', async () => {
    connectionManager.createDmRoom(FED_GROUP, 'alice');
    connectionManager.setVoiceWs('alice', ws('alice'));
    relayedFrom(processDmCallAcceptEvent, relay('dm_call_accept', DAVE));
    await accept({ dmChannelId: FED_GROUP }, 'bob', ws('bob'));
    clearReceived();

    relayedFrom(processDmCallEndEvent, relay('dm_call_end', DAVE));
    relayedFrom(processDmCallRejectEvent, relay('dm_call_reject', ERIN));
    await settle();

    expect(participants(FED_GROUP)).toEqual(['alice', 'bob']);
    expect(connectionManager.getRoom(FED_GROUP)?.metadata).toMatchObject({ state: 'active' });
    expect(received('bob', 'dm_call_ended')).toEqual([]);
  });

  it('drops the participants of a peer that went away and ends the call they leave empty', async () => {
    await callWith(DAVE);
    await end({ dmChannelId: FED_GROUP }, 'alice');
    clearReceived();

    expect(connectionManager.dropRemoteCallParticipants(PEER)).toBe(1);

    expect(connectionManager.getRoom(FED_GROUP)).toBeUndefined();
    expect(received('bob', 'dm_call_ended')).toHaveLength(1);
  });
});

describe('group call hosted on a peer (this instance holds the entry)', () => {
  function entry(): FederatedCallEntry {
    return {
      dmChannelId: GROUP,
      federatedId: REMOTE_FID,
      callerId: 'dave-stub',
      callerHomeUserId: DAVE.homeUserId,
      federatedCallHost: PEER,
      livekitUrl: 'wss://peer.example/lk',
      tokens: new Map([['bob', 'tok-b'], ['carol', 'tok-c']]),
      ringedUserIds: ['bob', 'carol'],
      joinedUserIds: [],
      group: true,
      state: 'ringing',
      startedAt: Date.now(),
    };
  }

  it('relays a hang-up of a joined member and keeps the call for the others', async () => {
    connectionManager.createFederatedCall(entry());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    clearReceived();
    fetchMock.mockClear();

    await end({ federatedCallId: REMOTE_FID }, 'bob');

    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_end',
      federatedId: REMOTE_FID,
      call: expect.objectContaining({ perMember: true }),
    })]);
    expect(connectionManager.getFederatedCall(REMOTE_FID)?.joinedUserIds).toEqual([]);
    expect(received('carol', 'dm_call_ended')).toEqual([]);
  });

  it('neither relays nor ends anything for a member who is not in the call', async () => {
    connectionManager.createFederatedCall(entry());
    clearReceived();

    await end({ federatedCallId: REMOTE_FID }, 'carol');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(connectionManager.getFederatedCall(REMOTE_FID)).toBeDefined();
    expect(received('bob', 'dm_call_ended')).toEqual([]);
  });

  it('stops only the decliner ringing and relays the decline', async () => {
    connectionManager.createFederatedCall(entry());
    clearReceived();

    await reject({ federatedCallId: REMOTE_FID }, 'carol');

    expect(received('carol', 'dm_call_rejected')).toHaveLength(1);
    expect(received('bob', 'dm_call_rejected')).toEqual([]);
    expect(connectionManager.getFederatedCall(REMOTE_FID)?.ringedUserIds).toEqual(['bob']);
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_reject',
      federatedId: REMOTE_FID,
      call: expect.objectContaining({ perMember: true }),
    })]);
  });

  function startFromPeer(perMember: boolean): void {
    seedDm('dm-remote-group', 'dave-stub', REMOTE_FID, ['bob', 'carol', 'dave-stub']);
    const tokenFor = (homeUserId: string) => ({ homeUserId, homeInstance: 'https://local.example', token: `tok-${homeUserId}` });
    const event: FederationRelayEvent = {
      eventType: 'dm_call_start',
      messageId: 'start-1',
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: REMOTE_FID,
      call: {
        livekitUrl: 'wss://peer.example/lk',
        tokens: { bob: 'tok-bob', carol: 'tok-carol' },
        memberTokens: [tokenFor('bob'), tokenFor('carol')],
        caller: { ...DAVE, displayName: 'Dave' },
        ...(perMember ? { perMember: true } : {}),
      },
    };
    processDmCallStartEvent(event, PEER, testDb, [], [], []);
  }

  it('applies the group rules to a call whose host says it does', async () => {
    startFromPeer(true);
    expect(connectionManager.getFederatedCall(REMOTE_FID)?.group).toBe(true);

    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    await accept({ federatedCallId: REMOTE_FID }, 'carol', ws('carol'));
    clearReceived();
    await end({ federatedCallId: REMOTE_FID }, 'bob');

    expect(connectionManager.getFederatedCall(REMOTE_FID)?.joinedUserIds).toEqual(['carol']);
    expect(received('carol', 'dm_call_ended')).toEqual([]);
  });

  it('keeps the 1.8.0 rules for a group call from a 1.8.0 host', async () => {
    // A 1.8.0 host ends the whole call on one member's end and does not tell
    // the instance that relayed it, so this instance ends it for its members.
    startFromPeer(false);
    expect(connectionManager.getFederatedCall(REMOTE_FID)?.group).toBe(false);

    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    await accept({ federatedCallId: REMOTE_FID }, 'carol', ws('carol'));
    clearReceived();
    fetchMock.mockClear();
    await end({ federatedCallId: REMOTE_FID }, 'bob');

    expect(connectionManager.getFederatedCall(REMOTE_FID)).toBeUndefined();
    expect(received('carol', 'dm_call_ended')).toHaveLength(1);
    const relayed = relayedTo(PEER);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.call).not.toHaveProperty('perMember');
  });

  it('ends the call for every member here when the host relays its end', async () => {
    startFromPeer(true);
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    clearReceived();

    const result = relayedFrom(processDmCallEndEvent, {
      eventType: 'dm_call_end',
      messageId: 'end-1',
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: REMOTE_FID,
      call: { endedBy: DAVE },
    });

    expect(result.accepted).toEqual(['end-1']);
    expect(connectionManager.getFederatedCall(REMOTE_FID)).toBeUndefined();
    expect(received('bob', 'dm_call_ended')).toHaveLength(1);
    expect(received('carol', 'dm_call_ended')).toHaveLength(1);
  });
});

/** A call hosted on the peer, held here, that bob and carol were rung for. */
function peerCall(partial: Partial<FederatedCallEntry> = {}): FederatedCallEntry {
  return {
    dmChannelId: GROUP,
    federatedId: REMOTE_FID,
    callerId: 'dave-stub',
    callerHomeUserId: DAVE.homeUserId,
    federatedCallHost: PEER,
    livekitUrl: 'wss://peer.example/lk',
    tokens: new Map([['bob', 'tok-b'], ['carol', 'tok-c']]),
    ringedUserIds: ['bob', 'carol'],
    joinedUserIds: [],
    group: true,
    state: 'ringing',
    startedAt: Date.now(),
    ...partial,
  };
}

/** Close `userId`'s main socket, as a closed tab or a lost network does. */
function closeSocket(userId: string): void {
  connectionManager.removeConnection(ws(userId));
}

const BOB_HERE = { homeUserId: 'bob', homeInstance: 'https://local.example' };

describe('a member here who leaves a call hosted on a peer without hanging up', () => {
  it('leaves a group call once the session is gone past the grace, and the host is told', async () => {
    connectionManager.createFederatedCall(peerCall());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    fetchMock.mockClear();

    closeSocket('bob');
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS - 1);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await settle();

    // Nobody here is in the call and its ring window has closed, so the
    // record goes too.
    expect(connectionManager.getFederatedCall(REMOTE_FID)).toBeUndefined();
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_end',
      federatedId: REMOTE_FID,
      call: { endedBy: BOB_HERE, perMember: true },
    })]);
  });

  it('stays in the call when a new socket resumes the session within the grace', async () => {
    connectionManager.createFederatedCall(peerCall());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    fetchMock.mockClear();

    closeSocket('bob');
    const resumed = connect('bob');
    handleClientEvent({ type: 'voice_status', isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false }, 'bob', 'bob', resumed, false);
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS * 2);
    await settle();

    expect(connectionManager.getFederatedCall(REMOTE_FID)?.joinedUserIds).toEqual(['bob']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a 1-on-1 or 1.8.0 call only here, as before, and relays nothing', async () => {
    connectionManager.createFederatedCall(peerCall({ group: false }));
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    fetchMock.mockClear();

    closeSocket('bob');
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);
    await settle();

    expect(connectionManager.getFederatedCall(REMOTE_FID)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a group call on joining a voice channel here', async () => {
    connectionManager.createFederatedCall(peerCall());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    fetchMock.mockClear();

    handleClientEvent({ type: 'voice_join', channelId: VOICE_CHANNEL }, 'bob', 'bob', ws('bob'), false);
    await settle();

    expect(connectionManager.getUserRoom('bob')?.roomId).toBe(VOICE_CHANNEL);
    expect(connectionManager.getFederatedCall(REMOTE_FID)?.joinedUserIds).toEqual([]);
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_end',
      call: expect.objectContaining({ endedBy: BOB_HERE, perMember: true }),
    })]);
  });

  it('leaves a group call when the account is deleted', async () => {
    connectionManager.createFederatedCall(peerCall());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    fetchMock.mockClear();

    connectionManager.forceDisconnectUser('bob');
    await settle();

    expect(connectionManager.getFederatedCall(REMOTE_FID)?.joinedUserIds).toEqual([]);
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_end',
      call: expect.objectContaining({ perMember: true }),
    })]);
  });

  it('says on the relayed accept of a group call that it will relay the leave', async () => {
    connectionManager.createFederatedCall(peerCall());

    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));

    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_accept',
      call: { acceptor: BOB_HERE, perMember: true },
    })]);
  });

  it('keeps the 1.8.0 accept for a 1-on-1 or 1.8.0 call', async () => {
    connectionManager.createFederatedCall(peerCall({ group: false }));

    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));

    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_accept',
      call: { acceptor: BOB_HERE },
    })]);
  });
});

describe('a call record from a peer that is no longer live', () => {
  it('does not block a start once nobody here is in the call (group)', async () => {
    // The host ended the call without a dm_call_end reaching this instance.
    connectionManager.createFederatedCall(peerCall({ state: 'active' }));

    await start({ dmChannelId: GROUP }, 'carol', 'carol', ws('carol'));

    expect(received('carol', 'error')).toEqual([]);
    expect(connectionManager.getFederatedCall(REMOTE_FID)).toBeUndefined();
    expect(connectionManager.getRoom(GROUP)?.metadata).toMatchObject({ state: 'ringing', callerId: 'carol' });
  });

  it('does not block a start once nobody here is in the call (1-on-1)', async () => {
    // A 1.8.0 host ends a 1-on-1 without telling its peers when its last
    // participant's voice session runs out.
    connectionManager.createFederatedCall(peerCall({
      dmChannelId: ONE_ON_ONE, federatedId: PAIR_FED_FID, group: false, state: 'active', ringedUserIds: ['bob'],
    }));
    await accept({ dmChannelId: ONE_ON_ONE }, 'bob', ws('bob'));
    closeSocket('bob');
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);
    const resumed = connect('bob');
    fetchMock.mockClear();

    await start({ dmChannelId: ONE_ON_ONE }, 'bob', 'bob', resumed);

    expect(sentOn(resumed).filter(e => e.type === 'error')).toEqual([]);
    expect(connectionManager.getRoom(ONE_ON_ONE)?.metadata).toMatchObject({ state: 'ringing', callerId: 'bob' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets the starter out of a place no session holds any more, and tells the host', async () => {
    connectionManager.createFederatedCall(peerCall());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    // A reload: the old socket is gone, its grace still runs.
    closeSocket('bob');
    const reloaded = connect('bob');
    fetchMock.mockClear();

    await start({ dmChannelId: GROUP }, 'bob', 'bob', reloaded);
    await settle();

    expect(sentOn(reloaded).filter(e => e.type === 'error')).toEqual([]);
    expect(connectionManager.getRoom(GROUP)?.metadata).toMatchObject({ state: 'ringing', callerId: 'bob' });
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({
      eventType: 'dm_call_end',
      federatedId: REMOTE_FID,
      call: expect.objectContaining({ perMember: true }),
    })]);
  });

  it('refuses a start from another tab of a member still in the call', async () => {
    connectionManager.createFederatedCall(peerCall());
    await accept({ federatedCallId: REMOTE_FID }, 'bob', ws('bob'));
    const secondTab = connect('bob');

    await start({ dmChannelId: GROUP }, 'bob', 'bob', secondTab);

    expect(sentOn(secondTab)).toEqual([
      expect.objectContaining({ type: 'error', code: 'dm_call_in_progress', dmChannelId: GROUP }),
    ]);
    expect(connectionManager.getFederatedCall(REMOTE_FID)?.joinedUserIds).toEqual(['bob']);
  });

  it('refuses a start while the call still rings', async () => {
    connectionManager.createFederatedCall(peerCall());
    await reject({ federatedCallId: REMOTE_FID }, 'carol');

    await start({ dmChannelId: GROUP }, 'carol', 'carol', ws('carol'));

    expect(received('carol', 'error')).toEqual([
      expect.objectContaining({ code: 'dm_call_in_progress', dmChannelId: GROUP }),
    ]);
  });
});

describe('the end reaches the peers when the last participant here leaves', () => {
  async function callOfTwo(): Promise<void> {
    await start({ dmChannelId: FED_GROUP }, 'alice', 'alice', ws('alice'));
    await accept({ dmChannelId: FED_GROUP }, 'bob', ws('bob'));
    await end({ dmChannelId: FED_GROUP }, 'alice');
    expect(participants(FED_GROUP)).toEqual(['bob']);
    clearReceived();
    fetchMock.mockClear();
  }

  it('through the voice reconnect grace running out', async () => {
    await callOfTwo();

    closeSocket('bob');
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);
    await settle();

    expect(connectionManager.getRoom(FED_GROUP)).toBeUndefined();
    expect(received('alice', 'dm_call_ended')).toHaveLength(1);
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({ eventType: 'dm_call_end', federatedId: FED_GROUP_FID })]);
  });

  it('by joining a voice channel', async () => {
    await callOfTwo();

    handleClientEvent({ type: 'voice_join', channelId: VOICE_CHANNEL }, 'bob', 'bob', ws('bob'), false);
    await settle();

    expect(connectionManager.getRoom(FED_GROUP)).toBeUndefined();
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({ eventType: 'dm_call_end', federatedId: FED_GROUP_FID })]);
  });

  it('through account deletion', async () => {
    await callOfTwo();

    connectionManager.forceDisconnectUser('bob');
    await settle();

    expect(connectionManager.getRoom(FED_GROUP)).toBeUndefined();
    expect(received('alice', 'dm_call_ended')).toHaveLength(1);
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({ eventType: 'dm_call_end', federatedId: FED_GROUP_FID })]);
  });

  it('once, when the caller\'s socket closes while the group call rings', async () => {
    await start({ dmChannelId: FED_GROUP }, 'alice', 'alice', ws('alice'));
    fetchMock.mockClear();

    closeSocket('alice');
    vi.advanceTimersByTime(VOICE_RECONNECT_GRACE_MS);
    await settle();

    expect(connectionManager.getRoom(FED_GROUP)).toBeUndefined();
    expect(received('bob', 'dm_call_ended')).toHaveLength(1);
    expect(relayedTo(PEER)).toEqual([expect.objectContaining({ eventType: 'dm_call_end', federatedId: FED_GROUP_FID })]);
  });
});

describe('a relayed accept that moves a member between calls hosted here', () => {
  it('takes the member out of the call they sat in, which ends when that empties it', async () => {
    connectionManager.createDmRoom(FED_GROUP, 'alice');
    relayedFrom(processDmCallAcceptEvent, relay('dm_call_accept', DAVE, true));
    await end({ dmChannelId: FED_GROUP }, 'alice');
    expect(participants(FED_GROUP)).toEqual(['dave-stub']);
    connectionManager.createDmRoom(FED_GROUP_2, 'alice');
    clearReceived();
    fetchMock.mockClear();

    relayedFrom(processDmCallAcceptEvent, relay('dm_call_accept', DAVE, true, FED_GROUP_2_FID));
    await settle();

    expect(participants(FED_GROUP_2)).toEqual(['alice', 'dave-stub']);
    expect(connectionManager.getRoom(FED_GROUP)).toBeUndefined();
    expect(received('bob', 'voice_state_update')).toContainEqual(
      expect.objectContaining({ channelId: FED_GROUP, userId: 'dave-stub', action: 'leave' }),
    );
    expect(relayedTo(PEER)).toContainEqual(expect.objectContaining({
      eventType: 'dm_call_end',
      federatedId: FED_GROUP_FID,
      call: { endedBy: { homeUserId: 'alice', homeInstance: 'https://local.example' } },
    }));
  });

  it('does not seat the peer\'s acceptor of a 1-on-1, as in 1.8.0', async () => {
    connectionManager.createDmRoom(PAIR_FED, 'alice');

    relayedFrom(processDmCallAcceptEvent, relay('dm_call_accept', DAVE, true, PAIR_FED_FID));
    await settle();

    expect(participants(PAIR_FED)).toEqual(['alice']);
  });
});

describe('the ready payload', () => {
  it('does not ring again a member who declined a group call that still rings', async () => {
    await start({ dmChannelId: GROUP }, 'alice', 'alice', ws('alice'));
    await reject({ dmChannelId: GROUP }, 'bob');

    expect(buildReadyPayload('bob').activeCalls.map(c => c.dmChannelId)).not.toContain(GROUP);
    expect(buildReadyPayload('carol').activeCalls.map(c => c.dmChannelId)).toContain(GROUP);
  });

  it('does not ring again a member who declined a group call held from a peer', async () => {
    connectionManager.createFederatedCall(peerCall());
    await reject({ federatedCallId: REMOTE_FID }, 'carol');

    expect(buildReadyPayload('carol').activeCalls.map(c => c.federatedCallId)).not.toContain(REMOTE_FID);
    expect(buildReadyPayload('bob').activeCalls.map(c => c.federatedCallId)).toContain(REMOTE_FID);
  });
});

describe('a refused dm_call_accept', () => {
  it('names the call that is gone, with a code, on the sending socket only', async () => {
    const secondTab = connect('bob');

    await accept({ dmChannelId: GROUP }, 'bob', secondTab);

    expect(sentOn(secondTab)).toEqual([
      expect.objectContaining({ type: 'error', code: 'dm_call_not_found', dmChannelId: GROUP }),
    ]);
    expect(sentOn(ws('bob'))).toEqual([]);
  });

  it('refuses a member of no such DM with a code', async () => {
    await accept({ dmChannelId: ONE_ON_ONE }, 'carol', ws('carol'));

    expect(received('carol', 'error')).toEqual([
      expect.objectContaining({ code: 'not_dm_member', dmChannelId: ONE_ON_ONE }),
    ]);
  });
});
