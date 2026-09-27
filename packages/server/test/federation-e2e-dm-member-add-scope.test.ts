import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  queuedRelayEvents,
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
 * ── e2e gate: a relayed member_add only changes a group the sender is part of ──
 *
 * A `member_add` for a group this instance does not hold yet is a bootstrap:
 * the event carries the roster, and the sender must speak for the group's
 * owner. A `member_add` for a group it already holds is incremental, and is
 * applied only when
 *   - the conversation is a group (1-on-1s have a fixed pair),
 *   - the adder is a current member of this instance's copy, and
 *   - the sending instance is one this instance relays the group to, judged on
 *     the roster before the add.
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
    expect(rejectionReason(await relayToB([into]), into.messageId)).toBe('invalid_target');
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
    const dm = await dmWithHomeUser(A, alice.token, bob, B);
    const sent = await sendDmMessage(A, alice.token, dm, { content: 'alice to bob, opener' });
    const opener = queuedOnce(A, dm, 'create').find(e => e.messageId === sent.id)!;
    expect((await relayToB([opener])).body?.accepted).toContain(opener.messageId);
    const pair = onB(pairFederatedId(alice.id, bob.id));

    const event = reaimed(await aliceAddsErin(), {
      federatedId: pairFederatedId(alice.id, bob.id),
      membership: { user: identity(carol, A), addedBy: identity(alice, A) },
    });

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(memberIds(B, pair)).toEqual([rowFor(B, alice.id), bob.id].sort());
  });
});
