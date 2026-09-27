import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  createDm,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  readDb,
  rejectionReason,
  sendDmMessage,
  waitUntil,
  withWritableDb,
  type PeeredHarness,
  type RelayPostResult,
} from './helpers/federationE2E.js';
import {
  channelByFederatedId,
  dmWithHomeUser,
  groupDelivered,
  queuedOnce,
  reaimed,
  rowFor,
} from './helpers/dmScope.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsCapture } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances over real HTTP; the 5s unit default is too tight.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate: a relayed reaction only touches a conversation the sender is part of ──
 *
 * A reaction names its message in shared coordinates. The receiver applies a
 * `reaction_add` or `reaction_remove` only when the sending instance is one of
 * the origins it relays that message's conversation to, or the instance the
 * message itself came from: the rule relayed edits and deletes follow
 * (`isPeerOfMessage`), else `invalid_target`. The reactor must also be a
 * member of that conversation, as the local reaction handlers require: else
 * `unauthorized_source` in a group (retried, since the reactor's add can land
 * later) and `invalid_target` in a 1-on-1. Nothing changes on a refusal.
 *
 * Topology (IDENTITY profile, A peered with B and with C):
 *   alice — native on A
 *   carol — native on A, in neither conversation below
 *   bob   — native on B
 *   erin  — native on B
 *   cora  — native on C
 * alice's group with bob and cora spans three instances. B is the receiver.
 * alice reacts on A over her real socket; A's queued events are posted,
 * signed, to B. Altered events start from one A really queued.
 *
 * Planted rows: A's relayed copy of a message bob sent on B. B's worker would
 * deliver it; this profile cannot deliver into A.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let secretOnB: string;

let alice: TestUser;
let carol: TestUser;
let bob: TestUser;
let erin: TestUser;
let cora: TestUser;
let aliceWs: WsCapture;

let groupOnA: string;
let bobMsgOnB: string;
let bobMsgOnA: string;
let bobErinMsg: string;
/** alice's opener in her 1-on-1 with bob, as A's id (B holds it relayed). */
let aliceBobMsgOnA: string;
/** The real events A queued for alice's reaction, reused as templates. */
let addTemplate: FederationRelayEvent;
let removeTemplate: FederationRelayEvent;

const EMOJI = '👍';

function relayToB(events: FederationRelayEvent[]): Promise<RelayPostResult> {
  return postSignedRelay(B, identityOrigin(A), secretOnB, events);
}

function reactionsOnB(messageId: string): Array<{ userId: string; emoji: string }> {
  return readDb(B, db =>
    db.prepare('SELECT user_id AS userId, emoji FROM dm_reactions WHERE dm_message_id = ?').all(messageId) as
      Array<{ userId: string; emoji: string }>,
  );
}

/**
 * alice reacts on A over her socket; returns the event A queued for it. A
 * removal is keyed by message, user and emoji, so each is sent once here.
 */
async function aliceReactsOnA(type: 'reaction_add' | 'reaction_remove'): Promise<FederationRelayEvent> {
  const before = new Set(queuedOnce(A, groupOnA, type).map(e => e.messageId));
  aliceWs.send({ type, messageId: bobMsgOnA, emoji: EMOJI });
  const queued = (): FederationRelayEvent | undefined =>
    queuedOnce(A, groupOnA, type).find(e => !before.has(e.messageId));
  if (!(await waitUntil(() => queued() !== undefined, 8_000))) throw new Error(`A queued no ${type}`);
  return queued()!;
}

/** The same event, made by carol instead of alice. */
function byCarol(event: FederationRelayEvent): FederationRelayEvent {
  return { ...event, reaction: { ...event.reaction!, userId: carol.id, homeUserId: carol.id, homeInstance: identityOrigin(A) } };
}

/** Deliver the create A queued for a message and require B to accept it. */
async function deliverCreate(dmOnA: string, messageId: string): Promise<void> {
  const create = queuedOnce(A, dmOnA, 'create').find(e => e.messageId === messageId);
  if (!create) throw new Error(`A queued no create for ${messageId}`);
  const res = await relayToB([create]);
  if (!res.body?.accepted.includes(create.messageId)) throw new Error(`create not accepted: ${res.raw}`);
}

/** The same event, aimed at another message on B. */
function aimedAt(template: FederationRelayEvent, messageId: string): FederationRelayEvent {
  return reaimed(template, { reaction: { ...template.reaction!, messageId, messageHomeInstance: identityOrigin(B) } });
}

beforeAll(async () => {
  h = await bootIdentityPeered(2);
  A = h.home;
  B = h.remotes[0]!;
  const C = h.remotes[1]!;
  secretOnB = peerSecretOn(B, identityOrigin(A));

  alice = await registerLocal(A, 'alice');
  carol = await registerLocal(A, 'carol');
  bob = await registerLocal(B, 'bob');
  erin = await registerLocal(B, 'erin');
  cora = await registerLocal(C, 'cora');

  const aliceBob = await dmWithHomeUser(A, alice.token, bob, B);
  await dmWithHomeUser(A, alice.token, cora, C);
  let fid: string;
  [groupOnA, fid] = await groupDelivered(A, alice, [
    { id: rowFor(A, bob.id), homeUserId: bob.id, homeInstance: B.domain },
    { id: rowFor(A, cora.id), homeUserId: cora.id, homeInstance: C.domain },
  ], relayToB);

  const groupOnB = channelByFederatedId(B, fid)!;
  const sent = await sendDmMessage(B, bob.token, groupOnB, { content: 'bob to the group' });
  if (sent.status !== 201 || !sent.id) throw new Error(`bob send failed: ${sent.status}`);
  bobMsgOnB = sent.id;
  bobMsgOnA = `e2e-mirror-${Math.floor(Math.random() * 1e9)}`;
  withWritableDb(A, db => {
    db.prepare(`
      INSERT INTO dm_messages (id, dm_channel_id, user_id, content, type, reply_to_id, created_at,
                               source_instance, source_message_id, encryption_version)
      VALUES (?, ?, ?, ?, 'user', NULL, ?, ?, ?, 0)
    `).run(bobMsgOnA, groupOnA, rowFor(A, bob.id), 'bob to the group', Date.now(), identityOrigin(B), bobMsgOnB);
  });

  // A conversation between two of B's users that B relays nowhere.
  const bobErin = await createDm(B, bob.token, erin.id);
  const other = await sendDmMessage(B, bob.token, bobErin, { content: 'bob to erin' });
  if (other.status !== 201 || !other.id) throw new Error(`bob to erin failed: ${other.status}`);
  bobErinMsg = other.id;

  // alice's 1-on-1 with bob, and one carol has with bob so B holds a row for her.
  const opener = await sendDmMessage(A, alice.token, aliceBob, { content: 'alice to bob' });
  if (opener.status !== 201 || !opener.id) throw new Error(`alice to bob failed: ${opener.status}`);
  aliceBobMsgOnA = opener.id;
  await deliverCreate(aliceBob, aliceBobMsgOnA);
  const carolBob = await dmWithHomeUser(A, carol.token, bob, B);
  const carolOpener = await sendDmMessage(A, carol.token, carolBob, { content: 'carol to bob' });
  if (carolOpener.status !== 201 || !carolOpener.id) throw new Error(`carol to bob failed: ${carolOpener.status}`);
  await deliverCreate(carolBob, carolOpener.id);

  aliceWs = await connectWs(A.origin, alice.token);
}, 120_000);

afterAll(async () => {
  aliceWs?.close();
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — reactions in a conversation the sender is part of are applied', () => {
  it('alice\'s reaction to bob\'s message in a group on three instances is added, then removed', async () => {
    const add = await aliceReactsOnA('reaction_add');
    addTemplate = add;
    expect((await relayToB([add])).body?.accepted).toContain(add.messageId);
    expect(reactionsOnB(bobMsgOnB)).toEqual([{ userId: rowFor(B, alice.id), emoji: EMOJI }]);

    const remove = await aliceReactsOnA('reaction_remove');
    removeTemplate = remove;
    expect((await relayToB([remove])).body?.accepted).toContain(remove.messageId);
    expect(reactionsOnB(bobMsgOnB)).toEqual([]);
  });
});

describe('federation e2e — a reaction is refused unless the sender is part of the message\'s conversation', () => {
  it('refuses a reaction on a message in a conversation the sending instance is not a peer of', async () => {
    const event = aimedAt(addTemplate, bobErinMsg);

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(reactionsOnB(bobErinMsg)).toEqual([]);
  });

  it('refuses a reaction removal on a message in a conversation the sending instance is not a peer of', async () => {
    withWritableDb(B, db => {
      db.prepare('INSERT INTO dm_reactions (id, dm_message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`e2e-reaction-${Date.now()}`, bobErinMsg, rowFor(B, alice.id), EMOJI, Date.now());
    });
    const event = aimedAt(removeTemplate, bobErinMsg);

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(reactionsOnB(bobErinMsg)).toEqual([{ userId: rowFor(B, alice.id), emoji: EMOJI }]);
  });
});

describe('federation e2e — a reaction is refused unless the reactor is a member of the message\'s conversation', () => {
  it('refuses a reaction to a group message by someone who is not in the group, for retry', async () => {
    const event = byCarol(aimedAt(addTemplate, bobMsgOnB));

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('unauthorized_source');
    expect(reactionsOnB(bobMsgOnB)).toEqual([]);
  });

  it('refuses a reaction removal on a group message by someone who is not in the group', async () => {
    withWritableDb(B, db => {
      db.prepare('INSERT INTO dm_reactions (id, dm_message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`e2e-reaction-carol-${Date.now()}`, bobMsgOnB, rowFor(B, carol.id), EMOJI, Date.now());
    });
    const event = byCarol(aimedAt(removeTemplate, bobMsgOnB));

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('unauthorized_source');
    expect(reactionsOnB(bobMsgOnB)).toEqual([{ userId: rowFor(B, carol.id), emoji: EMOJI }]);
  });

  it('refuses a reaction to a 1-on-1 message by someone who is not one of its two people', async () => {
    const onB = readDb(B, db =>
      (db.prepare('SELECT id FROM dm_messages WHERE source_message_id = ?').get(aliceBobMsgOnA) as { id: string }).id,
    );
    const event = byCarol(reaimed(addTemplate, {
      reaction: { ...addTemplate.reaction!, messageId: aliceBobMsgOnA, messageHomeInstance: identityOrigin(A) },
    }));

    const res = await relayToB([event]);
    expect(rejectionReason(res, event.messageId)).toBe('invalid_target');
    expect(reactionsOnB(onB)).toEqual([]);
  });
});
