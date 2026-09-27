import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationGroupPayload, FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  queuedRelayEvents,
  readDb,
  rejectionReason,
  sendDmMessage,
  withWritableDb,
  type PeeredHarness,
  type RelayPostResult,
} from './helpers/federationE2E.js';
import {
  befriend,
  channelByFederatedId,
  dmWithHomeUser,
  groupDelivered,
  memberIds,
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
 * ── e2e gate: relayed membership events only change a group the sender is part of ──
 *
 * A `member_add` for a group this instance does not hold yet is a bootstrap:
 * the event carries the roster, and is applied only when it names an owner,
 * the sender speaks for that owner, the owner is in the roster, and the
 * sender is one of the instances the roster lives on. A `member_add` for a
 * group it already holds is incremental, and is applied only when
 *   - the conversation is a group (1-on-1s have a fixed pair),
 *   - the adder is a current member of this instance's copy, and
 *   - the sending instance is one this instance relays the group to, judged on
 *     the roster before the add.
 * A kick (`member_remove` with a reason other than leave) and an
 * `ownership_transfer` are group operations: aimed at a 1-on-1 they are
 * refused.
 *
 * Topology (IDENTITY profile, A peered with B and with C):
 *   alice, carol — native on A
 *   bob, erin    — native on B
 *   dave         — native on B, with a federated account on A (proof on file)
 *   cora         — native on C
 * B is the receiver throughout. A's real events are read from A's outbox and
 * posted, signed, to B; altered events start from one A really queued.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let C: SpawnedInstance;
let secretOnB: string;

let alice: TestUser;
let carol: TestUser;
let bob: TestUser;
let erin: TestUser;
let dave: TestUser;
let daveOnA: TestUser;
let cora: TestUser;

let groupOnA: string;
let groupFid: string;
let carolGroupFid: string;

function relayToB(events: FederationRelayEvent[]): Promise<RelayPostResult> {
  return postSignedRelay(B, identityOrigin(A), secretOnB, events);
}

function onB(federatedId: string): string {
  const ch = channelByFederatedId(B, federatedId);
  if (!ch) throw new Error(`B holds no channel ${federatedId}`);
  return ch;
}

/** alice adds erin to her group on A; returns the member_add A queued for it. */
let erinAdd: FederationRelayEvent | undefined;
async function aliceAddsErin(): Promise<FederationRelayEvent> {
  if (erinAdd) return erinAdd;
  const erinOnA = rowFor(A, erin.id);
  befriend(A, alice.id, [erinOnA]);
  const before = new Set(queuedRelayEvents(A, groupOnA, 'member_add').map(e => e.messageId));
  await postAs(A, alice.token, `/api/dm/${groupOnA}/members`, { userId: erinOnA });
  const added = queuedOnce(A, groupOnA, 'member_add').find(e => !before.has(e.messageId));
  if (!added) throw new Error('A queued no member_add for erin');
  erinAdd = added;
  return added;
}

const identity = (user: TestUser, inst: SpawnedInstance): { homeUserId: string; homeInstance: string } =>
  ({ homeUserId: user.id, homeInstance: identityOrigin(inst) });

/** The alice-bob 1-on-1 as B holds it, opened by a message alice sent on A. */
let aliceBob: string | undefined;
async function aliceBobOnB(): Promise<string> {
  if (aliceBob) return aliceBob;
  const dm = await dmWithHomeUser(A, alice.token, bob, B);
  const sent = await sendDmMessage(A, alice.token, dm, { content: 'alice to bob, opener' });
  const opener = queuedOnce(A, dm, 'create').find(e => e.messageId === sent.id);
  if (!opener) throw new Error('A queued no create for the opener');
  const res = await relayToB([opener]);
  if (!res.body?.accepted.includes(opener.messageId)) throw new Error(`opener not accepted: ${res.raw}`);
  aliceBob = onB(pairFederatedId(alice.id, bob.id));
  return aliceBob;
}

/**
 * A kick and an ownership transfer A really queued: alice kicks carol from a
 * group she shares with bob, then hands the group to bob.
 */
let groupOps: { kick: FederationRelayEvent; transfer: FederationRelayEvent } | undefined;
async function kickAndTransfer(): Promise<{ kick: FederationRelayEvent; transfer: FederationRelayEvent }> {
  if (groupOps) return groupOps;
  const bobOnA = rowFor(A, bob.id);
  const [group] = await groupDelivered(A, alice, [
    { id: carol.id },
    { id: bobOnA, homeUserId: bob.id, homeInstance: B.domain },
  ], relayToB);
  const kicked = await fetch(`${A.origin}/api/dm/${group}/members/${carol.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (!kicked.ok) throw new Error(`kick failed: ${kicked.status} ${await kicked.text()}`);
  await postAs(A, alice.token, `/api/dm/${group}/transfer`, { newOwnerId: bobOnA });
  const kick = queuedOnce(A, group, 'member_remove')[0];
  const transfer = queuedOnce(A, group, 'ownership_transfer')[0];
  if (!kick || !transfer) throw new Error('A queued no kick or no transfer');
  groupOps = { kick, transfer };
  return groupOps;
}

function channelRowOnB(channelId: string): { ownerId: string | null; deletedAt: number | null } {
  return readDb(B, db =>
    db.prepare('SELECT owner_id AS ownerId, deleted_at AS deletedAt FROM dm_channels WHERE id = ?').get(channelId) as
      { ownerId: string | null; deletedAt: number | null },
  );
}

/** A federatedId no instance has used. */
const freshFid = (label: string): string => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

beforeAll(async () => {
  h = await bootIdentityPeered(2);
  A = h.home;
  B = h.remotes[0]!;
  C = h.remotes[1]!;
  secretOnB = peerSecretOn(B, identityOrigin(A));

  alice = await registerLocal(A, 'alice');
  carol = await registerLocal(A, 'carol');
  bob = await registerLocal(B, 'bob');
  erin = await registerLocal(B, 'erin');
  ({ homeUser: dave, remoteUser: daveOnA } = await createFederatedUser(B, A, 'dave'));
  cora = await registerLocal(C, 'cora');
  await putProofOnFile(B, dave, identityOrigin(A), A.domain, daveOnA);

  // A's rows for the users homed elsewhere.
  await dmWithHomeUser(A, alice.token, bob, B);
  await dmWithHomeUser(A, alice.token, erin, B);
  await dmWithHomeUser(A, alice.token, cora, C);

  [, carolGroupFid] = await groupDelivered(A, carol, [
    { id: rowFor(A, bob.id), homeUserId: bob.id, homeInstance: B.domain },
    { id: rowFor(A, erin.id), homeUserId: erin.id, homeInstance: B.domain },
  ], relayToB);
}, 120_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — legitimate member_add events are applied', () => {
  it('a new group arrives as a bootstrap carrying its roster, members on three instances', async () => {
    befriend(A, alice.id, [carol.id, rowFor(A, bob.id), rowFor(A, cora.id)]);
    const group = await postAs<{ id: string; federatedId: string }>(A, alice.token, '/api/dm/group', {
      users: [
        { id: carol.id },
        { id: rowFor(A, bob.id), homeUserId: bob.id, homeInstance: B.domain },
        { id: rowFor(A, cora.id), homeUserId: cora.id, homeInstance: C.domain },
      ],
    });
    groupOnA = group.id;
    groupFid = group.federatedId;
    expect(channelByFederatedId(B, groupFid)).toBeUndefined();

    // One event per remote member; the first finds no channel and bootstraps
    // it from the roster, the second is an incremental add from a member.
    const adds = queuedOnce(A, groupOnA, 'member_add');
    expect(adds).toHaveLength(2);
    const res = await relayToB(adds);
    expect(res.body?.rejected).toEqual([]);
    expect(memberIds(B, onB(groupFid))).toEqual(
      [rowFor(B, alice.id), rowFor(B, carol.id), bob.id, rowFor(B, cora.id)].sort(),
    );
  });

  it('a member adding someone through the sending instance is applied', async () => {
    const add = await aliceAddsErin();
    const res = await relayToB([add]);
    expect(res.body?.accepted).toContain(add.messageId);
    expect(memberIds(B, onB(groupFid))).toContain(erin.id);
  });
});

describe('federation e2e — a member_add is refused unless the adder may add to that group', () => {
  it('refuses an add by someone who is not a member of the group, and leaves the roster as it was', async () => {
    const before = memberIds(B, onB(carolGroupFid));
    const event = reaimed(await aliceAddsErin(), {
      federatedId: carolGroupFid,
      membership: { user: identity(alice, A), addedBy: identity(alice, A) },
    });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('unauthorized_source');
    expect(memberIds(B, onB(carolGroupFid))).toEqual(before);

    // So a message alice then sends there is still refused.
    const sent = await sendDmMessage(A, alice.token, groupOnA, { content: 'alice group template' });
    const create = queuedOnce(A, groupOnA, 'create').find(e => e.messageId === sent.id)!;
    const into = reaimed(create, { federatedId: carolGroupFid, message: { ...create.message!, content: 'alice after a refused add' } });
    expect(rejectionReason(await relayToB([into]), into.messageId)).toBe('unauthorized_source');
  });

  it('refuses a homeward add into a group no member of which lives on the sending instance', async () => {
    befriend(B, dave.id, [bob.id, erin.id]);
    const group = await postAs<{ id: string }>(B, dave.token, '/api/dm/group', { users: [{ id: bob.id }, { id: erin.id }] });
    const fid = `not-shared-with-a-${group.id}`;
    withWritableDb(B, db => {
      db.prepare('UPDATE dm_channels SET federated_id = ? WHERE id = ?').run(fid, group.id);
    });
    const before = memberIds(B, group.id);

    const event = reaimed(await aliceAddsErin(), {
      federatedId: fid,
      membership: { user: identity(alice, A), addedBy: identity(dave, B) },
    });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('unauthorized_source');
    expect(memberIds(B, group.id)).toEqual(before);
  });

  it('refuses an add into a 1-on-1', async () => {
    const pair = await aliceBobOnB();

    const event = reaimed(await aliceAddsErin(), {
      federatedId: pairFederatedId(alice.id, bob.id),
      membership: { user: identity(carol, A), addedBy: identity(alice, A) },
    });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(memberIds(B, pair)).toEqual([rowFor(B, alice.id), bob.id].sort());
  });
});

describe('federation e2e — a bootstrap is refused unless its owner is in the roster and the sender is one of its instances', () => {
  it('refuses a bootstrap that names no owner, and creates no group', async () => {
    const add = await aliceAddsErin();
    const fid = freshFid('ownerless');
    const ownerless = { ...add.group!, owner: undefined } as unknown as FederationGroupPayload;
    const event = reaimed(add, { federatedId: fid, group: ownerless });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(channelByFederatedId(B, fid)).toBeUndefined();
  });

  it('refuses a bootstrap whose owner is not in its roster, and creates no group', async () => {
    const add = await aliceAddsErin();
    const fid = freshFid('owner-outside');
    const event = reaimed(add, {
      federatedId: fid,
      membership: { user: identity(erin, B), addedBy: identity(alice, A) },
      group: { ...add.group!, owner: identity(alice, A), members: [identity(bob, B), identity(erin, B)] },
    });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(channelByFederatedId(B, fid)).toBeUndefined();
  });

  it('refuses a homeward bootstrap of a group none of whose members lives on the sending instance', async () => {
    const add = await aliceAddsErin();
    const fid = freshFid('b-only');
    const event = reaimed(add, {
      federatedId: fid,
      membership: { user: identity(erin, B), addedBy: identity(dave, B) },
      group: { ...add.group!, owner: identity(dave, B), members: [identity(dave, B), identity(bob, B), identity(erin, B)] },
    });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(channelByFederatedId(B, fid)).toBeUndefined();
  });
});

describe('federation e2e — kicks and ownership transfers are refused on a 1-on-1', () => {
  it('refuses a kick from a 1-on-1 and leaves both people in it', async () => {
    const pair = await aliceBobOnB();
    const { kick } = await kickAndTransfer();
    const event = reaimed(kick, {
      federatedId: pairFederatedId(alice.id, bob.id),
      membership: { user: identity(bob, B), removedBy: identity(alice, A), reason: 'kick' },
    });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(memberIds(B, pair)).toEqual([rowFor(B, alice.id), bob.id].sort());
    expect(channelRowOnB(pair).deletedAt).toBeNull();
  });

  it('refuses an ownership transfer of a 1-on-1 and leaves it without an owner', async () => {
    const pair = await aliceBobOnB();
    const { transfer } = await kickAndTransfer();
    const event = reaimed(transfer, {
      federatedId: pairFederatedId(alice.id, bob.id),
      ownership: { previousOwner: identity(alice, A), newOwner: identity(alice, A) },
    });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(channelRowOnB(pair).ownerId).toBeNull();

    // So the pair still takes no third member.
    const add = reaimed(await aliceAddsErin(), {
      federatedId: pairFederatedId(alice.id, bob.id),
      membership: { user: identity(carol, A), addedBy: identity(alice, A) },
    });
    expect(rejectionReason(await relayToB([add]), add.messageId)).toBe('invalid_target');
    expect(memberIds(B, pair)).toEqual([rowFor(B, alice.id), bob.id].sort());
  });
});
