import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import type { FederationRelayEvent, FederationRelayParticipant } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  queuedRelayEvents,
  rejectionReason,
  sendDmMessage,
  readDb,
  withWritableDb,
  type PeeredHarness,
  type RelayPostResult,
} from './helpers/federationE2E.js';
import { registerLocal, createFederatedUser, type TestUser } from './helpers/testUsers.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances over real HTTP; the 5s unit default is too tight.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate: a relayed message is only written into a conversation its author is in ──
 *
 * A relayed `create` names its conversation: a group by `federatedId`, a
 * 1-on-1 by the pair of participants whose ids hash to it. The receiver
 * accepts the message only when
 *   - the author is a member of that conversation (a group's roster on this
 *     instance; for a 1-on-1, one of the two people it is between), and
 *   - the signing peer is one of the origins this instance relays the
 *     conversation to (`getGroupDmTargetOrigins`), the same rule relayed edits
 *     and deletes follow.
 * Otherwise it is `invalid_target` (terminal) and nothing is written.
 *
 * Topology (IDENTITY profile, so B's inbound relay handling is fully real):
 *   alice, carol — native on A
 *   bob          — native on B, with a federated account on A
 *   dave         — native on B, with a federated account on A (proof on file)
 *   erin         — native on B
 * A's real events are read from A's outbox and posted, signed, to B. Where an
 * event is altered, it starts from one A really queued.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let secretOnB: string;

let alice: TestUser;
let carol: TestUser;
let bob: TestUser;
let bobOnA: TestUser;
let dave: TestUser;
let daveOnA: TestUser;
let erin: TestUser;

async function post<T>(inst: SpawnedInstance, token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${inst.origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return await res.json() as T;
}

/** Open a 1-on-1 on A with a user homed on B, by their home identity. */
async function dmOnAWith(token: string, user: TestUser): Promise<string> {
  return (await post<{ id: string }>(A, token, '/api/dm', { homeUserId: user.id, homeInstance: B.domain })).id;
}

function relayToB(events: FederationRelayEvent[]): Promise<RelayPostResult> {
  return postSignedRelay(B, identityOrigin(A), secretOnB, events);
}

/** Send on A and return the create event A queued for it. */
async function sendOnA(token: string, dmOnA: string, content: string): Promise<FederationRelayEvent> {
  const sent = await sendDmMessage(A, token, dmOnA, { content });
  if (sent.status !== 201 || !sent.id) throw new Error(`send on A failed: ${sent.status} ${sent.error}`);
  const event = queuedRelayEvents(A, dmOnA, 'create').find(e => e.messageId === sent.id);
  if (!event) throw new Error(`A queued no create for ${sent.id}`);
  return event;
}

/** Deliver A's create for a message and require B to accept it. */
async function sendOnADelivered(token: string, dmOnA: string, content: string): Promise<FederationRelayEvent> {
  const event = await sendOnA(token, dmOnA, content);
  const res = await relayToB([event]);
  if (!res.body?.accepted.includes(event.messageId)) throw new Error(`create not accepted: ${res.raw}`);
  return event;
}

/** An event A really queued, re-aimed: a fresh message id and content, plus the given changes. */
function reaimed(template: FederationRelayEvent, content: string, changes: Partial<FederationRelayEvent>): FederationRelayEvent {
  return {
    ...template,
    messageId: `reaimed-${crypto.randomBytes(6).toString('hex')}`,
    message: { ...template.message!, content },
    ...changes,
  };
}

function participant(user: TestUser, inst: SpawnedInstance): FederationRelayParticipant {
  return { homeUserId: user.id, homeInstance: identityOrigin(inst), profile: { username: user.username } };
}

/** Where B stored messages with this content: their conversations. */
function channelsOnBWith(content: string): string[] {
  return readDb(B, db =>
    (db.prepare('SELECT dm_channel_id AS ch FROM dm_messages WHERE content = ?').all(content) as { ch: string }[])
      .map(r => r.ch),
  );
}

function channelOnBByFederatedId(federatedId: string): string | undefined {
  return readDb(B, db =>
    (db.prepare('SELECT id FROM dm_channels WHERE federated_id = ?').get(federatedId) as { id: string } | undefined)?.id,
  );
}

function pairFederatedId(a: string, b: string): string {
  return crypto.createHash('sha256').update([a, b].sort().join(':')).digest('hex').slice(0, 32);
}

function befriend(inst: SpawnedInstance, userId: string, friendIds: string[]): void {
  withWritableDb(inst, db => {
    const insert = db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)');
    for (const friendId of friendIds) insert.run(userId, friendId, Date.now());
  });
}

/** The local id A holds for a user homed on B. */
function rowOnA(homeUserId: string): string {
  return readDb(A, db =>
    (db.prepare('SELECT id FROM users WHERE home_user_id = ?').get(homeUserId) as { id: string }).id,
  );
}

/**
 * Create a group on A and deliver its member_add events to B, so B holds its
 * copy the way it would in production. Returns [group id on A, federatedId].
 */
async function groupFromA(owner: TestUser, members: Array<{ id: string; homeUserId?: string; homeInstance?: string }>): Promise<[string, string]> {
  befriend(A, owner.id, members.map(m => m.id));
  const group = await post<{ id: string; federatedId: string | null }>(A, owner.token, '/api/dm/group', { users: members });
  if (!group.federatedId) throw new Error('group on A has no federatedId');
  const adds = queuedRelayEvents(A, group.id, 'member_add');
  const res = await relayToB(adds);
  for (const add of adds) {
    if (!res.body?.accepted.includes(add.messageId)) throw new Error(`member_add not accepted: ${res.raw}`);
  }
  return [group.id, group.federatedId];
}

let aliceBobOnA: string;
let aliceDaveOnA: string;
let carolBobOnA: string;
let aliceGroupOnA: string;
let aliceGroupFid: string;
let carolGroupFid: string;

async function putDaveProofOnFile(): Promise<void> {
  const registry = await fetch(`${B.origin}/api/users/@me/federation-registry`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dave.token}` },
    body: JSON.stringify({
      updatedAt: Date.now() + 1_000,
      registry: [{
        origin: identityOrigin(A), label: A.domain, username: daveOnA.username,
        remoteUserId: daveOnA.id, status: 'connected', addedAt: Date.now(), lastConnectedAt: Date.now(),
      }],
    }),
  });
  if (!registry.ok) throw new Error(`registry PUT failed: ${registry.status} ${await registry.text()}`);
}

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  secretOnB = peerSecretOn(B, identityOrigin(A));

  alice = await registerLocal(A, 'alice');
  carol = await registerLocal(A, 'carol');
  ({ homeUser: bob, remoteUser: bobOnA } = await createFederatedUser(B, A, 'bob'));
  ({ homeUser: dave, remoteUser: daveOnA } = await createFederatedUser(B, A, 'dave'));
  erin = await registerLocal(B, 'erin');
  await putDaveProofOnFile();

  aliceBobOnA = await dmOnAWith(alice.token, bob);
  aliceDaveOnA = await dmOnAWith(alice.token, dave);
  carolBobOnA = await dmOnAWith(carol.token, bob);
  await dmOnAWith(alice.token, erin); // gives A its row for erin

  [aliceGroupOnA, aliceGroupFid] = await groupFromA(alice, [
    { id: carol.id },
    { id: rowOnA(bob.id), homeUserId: bob.id, homeInstance: B.domain },
  ]);
  [, carolGroupFid] = await groupFromA(carol, [
    { id: rowOnA(bob.id), homeUserId: bob.id, homeInstance: B.domain },
    { id: rowOnA(erin.id), homeUserId: erin.id, homeInstance: B.domain },
  ]);
}, 120_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — legitimate creates are accepted', () => {
  it('the first message of a new 1-on-1 creates the conversation on the receiver', async () => {
    const pair = pairFederatedId(alice.id, bob.id);
    expect(channelOnBByFederatedId(pair)).toBeUndefined();
    await sendOnADelivered(alice.token, aliceBobOnA, 'alice to bob, first');
    const ch = channelOnBByFederatedId(pair);
    expect(ch).toBeDefined();
    expect(channelsOnBWith('alice to bob, first')).toEqual([ch]);
  });

  it('a message by a member of a group the sending peer shares is accepted', async () => {
    await sendOnADelivered(alice.token, aliceGroupOnA, 'alice to her group');
    expect(channelsOnBWith('alice to her group')).toEqual([channelOnBByFederatedId(aliceGroupFid)]);
  });

  it('a homeward message to a partner on the sending peer is accepted', async () => {
    await sendOnADelivered(daveOnA.token, aliceDaveOnA, 'dave via A to alice');
    expect(channelsOnBWith('dave via A to alice')).toEqual([channelOnBByFederatedId(pairFederatedId(alice.id, dave.id))]);
  });
});

describe('federation e2e — a create is refused unless its author is in the conversation', () => {
  it('refuses a group message whose author is not a member of the group', async () => {
    const template = await sendOnA(alice.token, aliceGroupOnA, 'alice group template');
    const event = reaimed(template, 'alice into carol\'s group', { federatedId: carolGroupFid });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(channelsOnBWith('alice into carol\'s group')).toEqual([]);
  });

  it('refuses a 1-on-1 message whose author is not one of the two people it is between', async () => {
    await sendOnADelivered(carol.token, carolBobOnA, 'carol to bob, opener');
    const carolBobOnB = channelOnBByFederatedId(pairFederatedId(carol.id, bob.id));
    expect(carolBobOnB).toBeDefined();

    const template = await sendOnA(alice.token, aliceBobOnA, 'alice 1-on-1 template');
    const event = reaimed(template, 'alice into carol and bob', {
      participants: [participant(carol, A), participant(bob, B), participant(alice, A)],
    });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(channelsOnBWith('alice into carol and bob')).toEqual([]);
  });
});

describe('federation e2e — a create is refused unless the sending peer is one the conversation is relayed to', () => {
  it('refuses a homeward group message when no member of the group lives on the sending peer', async () => {
    befriend(B, dave.id, [bob.id, erin.id]);
    const group = await post<{ id: string }>(B, dave.token, '/api/dm/group', { users: [{ id: bob.id }, { id: erin.id }] });
    // All three live on B, so B relays this group nowhere. The federatedId
    // stands in for one B shares with another instance: it is what a create
    // addresses a group by.
    const fid = `not-shared-with-a-${group.id}`;
    withWritableDb(B, db => {
      db.prepare('UPDATE dm_channels SET federated_id = ? WHERE id = ?').run(fid, group.id);
    });

    const template = await sendOnA(daveOnA.token, aliceDaveOnA, 'dave homeward template');
    const event = reaimed(template, 'dave via A into a B-only group', { federatedId: fid });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(channelsOnBWith('dave via A into a B-only group')).toEqual([]);
  });

  it('refuses a homeward 1-on-1 between two users of this instance and creates no conversation', async () => {
    // dave and bob both live on B; they talk on A through their accounts there.
    const onA = (await post<{ id: string }>(A, daveOnA.token, '/api/dm', { userId: bobOnA.id })).id;
    const event = await sendOnA(daveOnA.token, onA, 'dave via A to bob');
    expect(event.participants?.map(p => p.homeUserId).sort()).toEqual([dave.id, bob.id].sort());

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(channelsOnBWith('dave via A to bob')).toEqual([]);
    expect(channelOnBByFederatedId(pairFederatedId(dave.id, bob.id))).toBeUndefined();
  });
});
