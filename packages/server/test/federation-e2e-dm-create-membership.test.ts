import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent, FederationRelayParticipant } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  rejectionReason,
  sendDmMessage,
  readDb,
  withWritableDb,
  type PeeredHarness,
  type RelayPostResult,
} from './helpers/federationE2E.js';
import {
  befriend,
  channelByFederatedId,
  dmWithHomeUser,
  groupDelivered,
  pairFederatedId,
  postAs,
  putProofOnFile,
  queuedOnce,
  reaimed,
  rowFor,
} from './helpers/dmScope.js';
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
 * Otherwise nothing is written. A group's roster here changes through relayed
 * member adds, which can land after the new member's first message, so a
 * group refusal is `unauthorized_source` (retried); a 1-on-1's pair never
 * changes, so its refusal is `invalid_target` (terminal).
 *
 * Topology (IDENTITY profile, so B's inbound relay handling is fully real):
 *   alice, carol, frank — native on A
 *   bob                 — native on B, with a federated account on A
 *   dave                — native on B, with a federated account on A (proof on file)
 *   erin                — native on B
 * A's real events are read from A's outbox and posted, signed, to B. Where an
 * event is altered, it starts from one A really queued.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let secretOnB: string;

let alice: TestUser;
let carol: TestUser;
let frank: TestUser;
let bob: TestUser;
let bobOnA: TestUser;
let dave: TestUser;
let daveOnA: TestUser;
let erin: TestUser;

function relayToB(events: FederationRelayEvent[]): Promise<RelayPostResult> {
  return postSignedRelay(B, identityOrigin(A), secretOnB, events);
}

/** Send on A and return the create event A queued for it. */
async function sendOnA(token: string, dmOnA: string, content: string): Promise<FederationRelayEvent> {
  const sent = await sendDmMessage(A, token, dmOnA, { content });
  if (sent.status !== 201 || !sent.id) throw new Error(`send on A failed: ${sent.status} ${sent.error}`);
  const event = queuedOnce(A, dmOnA, 'create').find(e => e.messageId === sent.id);
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

/** An event A really queued, re-aimed with new content plus the given changes. */
function reaimedWith(template: FederationRelayEvent, content: string, changes: Partial<FederationRelayEvent>): FederationRelayEvent {
  return reaimed(template, { message: { ...template.message!, content }, ...changes });
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

let aliceBobOnA: string;
let aliceDaveOnA: string;
let carolBobOnA: string;
let aliceGroupOnA: string;
let aliceGroupFid: string;
let carolGroupFid: string;

const onB = (federatedId: string): string | undefined => channelByFederatedId(B, federatedId);

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  secretOnB = peerSecretOn(B, identityOrigin(A));

  alice = await registerLocal(A, 'alice');
  carol = await registerLocal(A, 'carol');
  frank = await registerLocal(A, 'frank');
  ({ homeUser: bob, remoteUser: bobOnA } = await createFederatedUser(B, A, 'bob'));
  ({ homeUser: dave, remoteUser: daveOnA } = await createFederatedUser(B, A, 'dave'));
  erin = await registerLocal(B, 'erin');
  await putProofOnFile(B, dave, identityOrigin(A), A.domain, daveOnA);

  aliceBobOnA = await dmWithHomeUser(A, alice.token, bob, B);
  aliceDaveOnA = await dmWithHomeUser(A, alice.token, dave, B);
  carolBobOnA = await dmWithHomeUser(A, carol.token, bob, B);
  await dmWithHomeUser(A, alice.token, erin, B); // gives A its row for erin

  [aliceGroupOnA, aliceGroupFid] = await groupDelivered(A, alice, [
    { id: carol.id },
    { id: rowFor(A, bob.id), homeUserId: bob.id, homeInstance: B.domain },
  ], relayToB);
  [, carolGroupFid] = await groupDelivered(A, carol, [
    { id: rowFor(A, bob.id), homeUserId: bob.id, homeInstance: B.domain },
    { id: rowFor(A, erin.id), homeUserId: erin.id, homeInstance: B.domain },
  ], relayToB);
}, 120_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — legitimate creates are accepted', () => {
  it('the first message of a new 1-on-1 creates the conversation on the receiver', async () => {
    const pair = pairFederatedId(alice.id, bob.id);
    expect(onB(pair)).toBeUndefined();
    await sendOnADelivered(alice.token, aliceBobOnA, 'alice to bob, first');
    const ch = onB(pair);
    expect(ch).toBeDefined();
    expect(channelsOnBWith('alice to bob, first')).toEqual([ch]);
  });

  it('a message by a member of a group the sending peer shares is accepted', async () => {
    await sendOnADelivered(alice.token, aliceGroupOnA, 'alice to her group');
    expect(channelsOnBWith('alice to her group')).toEqual([onB(aliceGroupFid)]);
  });

  it('a homeward message to a partner on the sending peer is accepted', async () => {
    await sendOnADelivered(daveOnA.token, aliceDaveOnA, 'dave via A to alice');
    expect(channelsOnBWith('dave via A to alice')).toEqual([onB(pairFederatedId(alice.id, dave.id))]);
  });

  it('a group message that arrives before its author\'s add is refused for retry, and accepted once the add lands', async () => {
    befriend(A, alice.id, [frank.id]);
    const addsBefore = new Set(queuedOnce(A, aliceGroupOnA, 'member_add').map(e => e.messageId));
    await postAs(A, alice.token, `/api/dm/${aliceGroupOnA}/members`, { userId: frank.id });
    const add = queuedOnce(A, aliceGroupOnA, 'member_add').find(e => !addsBefore.has(e.messageId));
    if (!add) throw new Error('A queued no member_add for frank');
    const create = await sendOnA(frank.token, aliceGroupOnA, 'frank, first in the group');

    const early = await relayToB([create]);
    expect(rejectionReason(early, create.messageId)).toBe('unauthorized_source');
    expect(channelsOnBWith('frank, first in the group')).toEqual([]);

    expect((await relayToB([add])).body?.accepted).toContain(add.messageId);
    const retried = await relayToB([create]);
    expect(retried.body?.accepted).toContain(create.messageId);
    expect(channelsOnBWith('frank, first in the group')).toEqual([onB(aliceGroupFid)]);
  });
});

describe('federation e2e — a create is refused unless its author is in the conversation', () => {
  it('refuses a group message whose author is not a member of the group', async () => {
    const template = await sendOnA(alice.token, aliceGroupOnA, 'alice group template');
    const event = reaimedWith(template, 'alice into carol\'s group', { federatedId: carolGroupFid });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('unauthorized_source');
    expect(channelsOnBWith('alice into carol\'s group')).toEqual([]);
  });

  it('refuses a 1-on-1 message whose author is not one of the two people it is between', async () => {
    await sendOnADelivered(carol.token, carolBobOnA, 'carol to bob, opener');
    const carolBobOnB = onB(pairFederatedId(carol.id, bob.id));
    expect(carolBobOnB).toBeDefined();

    const template = await sendOnA(alice.token, aliceBobOnA, 'alice 1-on-1 template');
    const event = reaimedWith(template, 'alice into carol and bob', {
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
    const group = await postAs<{ id: string }>(B, dave.token, '/api/dm/group', { users: [{ id: bob.id }, { id: erin.id }] });
    // All three live on B, so B relays this group nowhere. The federatedId
    // stands in for one B shares with another instance: it is what a create
    // addresses a group by.
    const fid = `not-shared-with-a-${group.id}`;
    withWritableDb(B, db => {
      db.prepare('UPDATE dm_channels SET federated_id = ? WHERE id = ?').run(fid, group.id);
    });

    const template = await sendOnA(daveOnA.token, aliceDaveOnA, 'dave homeward template');
    const event = reaimedWith(template, 'dave via A into a B-only group', { federatedId: fid });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('unauthorized_source');
    expect(channelsOnBWith('dave via A into a B-only group')).toEqual([]);
  });

  it('refuses a homeward 1-on-1 between two users of this instance and creates no conversation', async () => {
    // dave and bob both live on B; they talk on A through their accounts there.
    const onA = (await postAs<{ id: string }>(A, daveOnA.token, '/api/dm', { userId: bobOnA.id })).id;
    const event = await sendOnA(daveOnA.token, onA, 'dave via A to bob');
    expect(event.participants?.map(p => p.homeUserId).sort()).toEqual([dave.id, bob.id].sort());

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(channelsOnBWith('dave via A to bob')).toEqual([]);
    expect(onB(pairFederatedId(dave.id, bob.id))).toBeUndefined();
  });
});
