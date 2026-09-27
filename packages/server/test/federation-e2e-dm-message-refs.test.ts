import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  queuedRelayEvents,
  sendDmMessage,
  listDmMessages,
  readDb,
  withWritableDb,
  waitUntil,
  type DmMessageView,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, createFederatedUser, type TestUser } from './helpers/testUsers.js';
import { connectWs } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances over real HTTP; the 5s unit default is too tight.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate for #295: replies and reactions on the other side's messages ─────
 *
 * A DM message has a different id on every instance that holds a copy. A
 * reference to a message that crosses instances therefore has to name it in
 * coordinates both sides share: its id on the instance it was created on, plus
 * that instance's origin. Reactions already did (`reaction.messageId` +
 * `messageHomeInstance`). Replies did not: the relay carried the sender's
 * local `replyToId`, which the receiver rightly refuses to adopt, so the other
 * side saw every federated reply without its quote.
 *
 * Topology (IDENTITY profile, so B's inbound relay handling is fully real):
 *   alice — native on A, with a federated account on B (alice@A)
 *   bob   — native on B
 * The alice–bob DM exists on A (created through A's real federated DM path)
 * and on B (created by B's real relay receiver from A's first message).
 *
 * A's outbound relay events are the ones A's real send path queued: the suite
 * reads them from A's `federation_outbox` and posts them, HMAC-signed with the
 * secret the real handshake negotiated, to B's real `/api/federation/relay`.
 * Only the worker's HTTP POST is stood in for, because on loopback A's outbox
 * row targets B's identity origin, which no socket answers.
 *
 * The one planted row is bob's message as A holds it: a relayed copy that B's
 * worker would have delivered, which this profile cannot deliver into A.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let secretOnB: string;

let alice: TestUser;
let aliceOnB: TestUser;
let bob: TestUser;

/** The alice–bob DM on A. */
let dmOnA: string;
/** The same conversation on B. */
let dmOnB: string;

/** bob's message, native on B. */
let bobMessageOnB: string;
/** bob's message as A holds it (a relayed copy). */
let bobMessageOnA: string;

/** Deliver the create A queued for `messageIdOnA` to B, as A's worker would. */
async function deliverCreateToB(messageIdOnA: string): Promise<void> {
  const event = queuedRelayEvents(A, dmOnA, 'create').find(e => e.messageId === messageIdOnA);
  if (!event) throw new Error(`A queued no create for ${messageIdOnA}`);
  const res = await postSignedRelay(B, identityOrigin(A), secretOnB, [event]);
  expect(res.status).toBe(200);
  expect(res.body?.accepted).toContain(messageIdOnA);
}

function viewByContent(views: DmMessageView[], content: string): DmMessageView {
  const found = views.find(v => v.content === content);
  if (!found) throw new Error(`no message with content ${content}`);
  return found;
}

function idOnB(content: string): string {
  const row = readDb(B, db =>
    db.prepare('SELECT id FROM dm_messages WHERE content = ?').get(content) as { id: string } | undefined,
  );
  if (!row) throw new Error(`B holds no message "${content}"`);
  return row.id;
}

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  secretOnB = peerSecretOn(B, identityOrigin(A));

  ({ homeUser: alice, remoteUser: aliceOnB } = await createFederatedUser(A, B, 'alice'));
  bob = await registerLocal(B, 'bob');

  const created = await fetch(`${A.origin}/api/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ homeUserId: bob.id, homeInstance: B.domain }),
  });
  if (created.status !== 201 && created.status !== 200) throw new Error(`federated DM create failed: ${created.status}`);
  dmOnA = (await created.json() as { id: string }).id;

  // alice opens the conversation; B's real receiver creates its copy.
  const opener = await sendDmMessage(A, alice.token, dmOnA, { content: 'opener from alice' });
  if (opener.status !== 201 || !opener.id) throw new Error(`opener failed: ${opener.status}`);
  await deliverCreateToB(opener.id);
  const openerOnB = readDb(B, db =>
    db.prepare('SELECT dm_channel_id AS ch FROM dm_messages WHERE content = ?').get('opener from alice') as { ch: string },
  );
  dmOnB = openerOnB.ch;

  // bob answers on B.
  const bobSend = await sendDmMessage(B, bob.token, dmOnB, { content: 'question from bob' });
  if (bobSend.status !== 201 || !bobSend.id) throw new Error(`bob send failed: ${bobSend.status}`);
  bobMessageOnB = bobSend.id;

  // A's copy of bob's message, exactly as A's relay receiver stores it.
  const bobOnA = readDb(A, db =>
    db.prepare('SELECT id FROM users WHERE home_user_id = ?').get(bob.id) as { id: string },
  );
  bobMessageOnA = `e2e-mirror-${Date.now()}`;
  withWritableDb(A, db => {
    db.prepare(`
      INSERT INTO dm_messages (id, dm_channel_id, user_id, content, type, reply_to_id, created_at,
                               source_instance, source_message_id, encryption_version)
      VALUES (?, ?, ?, 'question from bob', 'user', NULL, ?, ?, ?, 0)
    `).run(bobMessageOnA, dmOnA, bobOnA.id, Date.now(), identityOrigin(B), bobMessageOnB);
  });
}, 90_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — replies keep their quote across instances (#295)', () => {
  it('setup control: both instances hold the conversation, and bob\'s message on each side', () => {
    expect(dmOnB).toBeTruthy();
    const members = readDb(B, db =>
      db.prepare('SELECT user_id AS id FROM dm_members WHERE dm_channel_id = ?').all(dmOnB) as { id: string }[],
    ).map(m => m.id).sort();
    expect(members).toEqual([aliceOnB.id, bob.id].sort());
    expect(readDb(A, db =>
      db.prepare('SELECT dm_channel_id AS ch FROM dm_messages WHERE id = ?').get(bobMessageOnA) as { ch: string },
    ).ch).toBe(dmOnA);
  });

  it('alice\'s reply to bob\'s message reaches B quoting bob\'s original', async () => {
    const reply = await sendDmMessage(A, alice.token, dmOnA, {
      content: 'answer to bob',
      replyToId: bobMessageOnA,
    });
    expect(reply.status).toBe(201);
    // Home side: the reply quotes the local copy.
    expect(viewByContent(await listDmMessages(A, alice.token, dmOnA), 'answer to bob').replyTo?.id).toBe(bobMessageOnA);

    await deliverCreateToB(reply.id!);

    const onB = viewByContent(await listDmMessages(B, bob.token, dmOnB), 'answer to bob');
    expect(onB.replyTo?.id).toBe(bobMessageOnB);
  });

  it('alice\'s reply to her own message reaches B quoting B\'s copy of it', async () => {
    const own = await sendDmMessage(A, alice.token, dmOnA, { content: 'alice says something' });
    expect(own.status).toBe(201);
    await deliverCreateToB(own.id!);
    const ownOnB = idOnB('alice says something');

    const reply = await sendDmMessage(A, alice.token, dmOnA, {
      content: 'alice follows up',
      replyToId: own.id!,
    });
    expect(reply.status).toBe(201);
    await deliverCreateToB(reply.id!);

    const onB = viewByContent(await listDmMessages(B, bob.token, dmOnB), 'alice follows up');
    expect(onB.replyTo?.id).toBe(ownOnB);
  });

  it('a reply reference naming a message in another conversation is not adopted', async () => {
    // A message bob has in a different DM on B.
    const carol = await registerLocal(B, 'carol');
    const other = await fetch(`${B.origin}/api/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ userId: carol.id }),
    });
    const otherDm = (await other.json() as { id: string }).id;
    const elsewhere = await sendDmMessage(B, bob.token, otherDm, { content: 'bob to carol' });
    expect(elsewhere.status).toBe(201);

    // A legitimate reply, then the same event re-aimed at the other conversation.
    const reply = await sendDmMessage(A, alice.token, dmOnA, {
      content: 'aimed elsewhere',
      replyToId: bobMessageOnA,
    });
    expect(reply.status).toBe(201);
    const event = queuedRelayEvents(A, dmOnA, 'create').find(e => e.messageId === reply.id);
    expect(event?.message?.replyTo).toEqual({ messageId: bobMessageOnB, messageHomeInstance: identityOrigin(B) });
    const reaimed: FederationRelayEvent = {
      ...event!,
      message: { ...event!.message!, replyTo: { messageId: elsewhere.id!, messageHomeInstance: identityOrigin(B) } },
    };
    const res = await postSignedRelay(B, identityOrigin(A), secretOnB, [reaimed]);
    expect(res.body?.accepted).toContain(reply.id);

    const stored = readDb(B, db =>
      db.prepare('SELECT reply_to_id AS replyToId, dm_channel_id AS ch FROM dm_messages WHERE content = ?')
        .get('aimed elsewhere') as { replyToId: string | null; ch: string },
    );
    expect(stored.ch).toBe(dmOnB);
    expect(stored.replyToId).toBeNull();
  });
});

describe('federation e2e — reactions from a federated account persist (#295)', () => {
  it('alice reacting through her account on B is stored and broadcast', async () => {
    const aliceWs = await connectWs(B.origin, aliceOnB.token);
    const bobWs = await connectWs(B.origin, bob.token);
    try {
      aliceWs.send({ type: 'reaction_add', messageId: bobMessageOnB, emoji: '👍' });

      const broadcast = await waitUntil(
        () => bobWs.events.some(e => e.type === 'reaction_added' && e.messageId === bobMessageOnB),
        8_000,
      );
      expect(broadcast).toBe(true);
      const rows = readDb(B, db =>
        db.prepare('SELECT user_id AS userId FROM dm_reactions WHERE dm_message_id = ? AND emoji = ?')
          .all(bobMessageOnB, '👍') as { userId: string }[],
      );
      expect(rows.map(r => r.userId)).toEqual([aliceOnB.id]);

      // The relay home to A names bob's message in shared coordinates.
      const relayed = queuedRelayEvents(B, dmOnB, 'reaction_add');
      expect(relayed.map(e => e.reaction?.messageId)).toContain(bobMessageOnB);
      expect(relayed.find(e => e.reaction?.messageId === bobMessageOnB)?.reaction?.messageHomeInstance)
        .toBe(identityOrigin(B));

      aliceWs.send({ type: 'reaction_remove', messageId: bobMessageOnB, emoji: '👍' });
      const removed = await waitUntil(
        () => bobWs.events.some(e => e.type === 'reaction_removed' && e.messageId === bobMessageOnB),
        8_000,
      );
      expect(removed).toBe(true);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });

  it('a reaction alice makes on her home A reaches B as her account there', async () => {
    // The event is the one A's real send path queued, so its reactor pair
    // (alice's id, A's origin as a full URL) is what every sender emits. B
    // resolves it by homeUserId + homeInstance to alice's account on B, whose
    // home is stored as a bare domain.
    const aliceWs = await connectWs(A.origin, alice.token);
    try {
      aliceWs.send({ type: 'reaction_add', messageId: bobMessageOnA, emoji: '🎉' });
      const queued = await waitUntil(
        () => queuedRelayEvents(A, dmOnA, 'reaction_add').some(e => e.reaction?.emoji === '🎉'),
        8_000,
      );
      expect(queued).toBe(true);
    } finally {
      aliceWs.close();
    }
    const event = queuedRelayEvents(A, dmOnA, 'reaction_add').find(e => e.reaction?.emoji === '🎉')!;
    expect(event.reaction?.homeUserId).toBe(alice.id);

    const res = await postSignedRelay(B, identityOrigin(A), secretOnB, [event]);
    expect(res.status).toBe(200);
    expect(res.body?.accepted).toContain(event.messageId);
    const rows = readDb(B, db =>
      db.prepare('SELECT user_id AS userId FROM dm_reactions WHERE dm_message_id = ? AND emoji = ?')
        .all(bobMessageOnB, '🎉') as { userId: string }[],
    );
    expect(rows.map(r => r.userId)).toEqual([aliceOnB.id]);
  });
});
