import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  queuedRelayEvents,
  createDm,
  sendDmMessage,
  listDmMessages,
  readDb,
  waitUntil,
  settleRelays,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, createFederatedUser, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsCapture, type WsEvent } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances over real HTTP; the 5s unit default is too tight.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── Server-side evidence for #296: a DM message stays in its conversation ────
 *
 * #296: alice (home A) messages bob (home B) while carol (also on A) has an
 * unread DM with alice, and alice's client shows the message in carol's DM.
 * The fault was in alice's client (see web `utils/dmMessageRouting.test.ts`).
 * This suite pins down the server half of that finding: neither instance
 * stores the message outside the alice–bob conversation or sends it to anyone
 * outside it, and the mirrored copy B pushes to alice's account there is
 * labelled with B's id for that same conversation. It passed before the client
 * fix as well; it is here so a server regression of the same shape is caught.
 *
 * Topology (IDENTITY profile, so B's inbound relay handling is fully real):
 *   alice — native on A, with a federated account on B
 *   carol — native on A
 *   bob   — native on B
 * A's real create event is read from A's outbox and posted, signed, to B.
 *
 * Non-vacuity: carol's socket is shown to receive a message alice does send
 * her, and alice's account on B is shown to receive the mirrored copy, before
 * the negatives are asserted.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;

let alice: TestUser;
let aliceOnB: TestUser;
let carol: TestUser;
let bob: TestUser;

let carolDm: string;
let bobDmOnA: string;

const createdWith = (ws: WsCapture, content: string): WsEvent[] =>
  ws.events.filter(e =>
    e.type === 'dm_message_created'
    && (e.message as { content?: string | null } | undefined)?.content === content);

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;

  ({ homeUser: alice, remoteUser: aliceOnB } = await createFederatedUser(A, B, 'alice'));
  carol = await registerLocal(A, 'carol');
  bob = await registerLocal(B, 'bob');

  carolDm = await createDm(A, carol.token, alice.id);
  const unread = await sendDmMessage(A, carol.token, carolDm, { content: 'hi alice' });
  if (unread.status !== 201) throw new Error(`carol send failed: ${unread.status}`);

  const created = await fetch(`${A.origin}/api/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ homeUserId: bob.id, homeInstance: B.domain }),
  });
  if (created.status !== 201 && created.status !== 200) throw new Error(`federated DM create failed: ${created.status}`);
  bobDmOnA = (await created.json() as { id: string }).id;
}, 90_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — a DM message never leaves its conversation (#296)', () => {
  it('alice\'s message to bob is stored and delivered only within the alice–bob conversation', async () => {
    const carolWs = await connectWs(A.origin, carol.token);
    const aliceOnBWs = await connectWs(B.origin, aliceOnB.token);
    try {
      const sent = await sendDmMessage(A, alice.token, bobDmOnA, { content: 'for bob only' });
      expect(sent.status).toBe(201);

      const event = queuedRelayEvents(A, bobDmOnA, 'create').find(e => e.messageId === sent.id);
      expect(event).toBeDefined();
      const res = await postSignedRelay(B, identityOrigin(A), peerSecretOn(B, identityOrigin(A)), [event!]);
      expect(res.body?.accepted).toContain(sent.id);

      // B's copy of the conversation, and the members it holds.
      const onB = readDb(B, db =>
        db.prepare('SELECT id, dm_channel_id AS ch FROM dm_messages WHERE content = ?').all('for bob only') as
          { id: string; ch: string }[],
      );
      expect(onB).toHaveLength(1);
      const bobDmOnB = onB[0]!.ch;
      const membersOnB = readDb(B, db =>
        db.prepare('SELECT user_id AS id FROM dm_members WHERE dm_channel_id = ?').all(bobDmOnB) as { id: string }[],
      ).map(m => m.id).sort();
      expect(membersOnB).toEqual([aliceOnB.id, bob.id].sort());

      // POSITIVE CONTROL: the mirrored copy B pushes to alice's account there
      // arrives, and it is labelled with B's id for the alice–bob conversation.
      expect(await waitUntil(() => createdWith(aliceOnBWs, 'for bob only').length > 0, 8_000)).toBe(true);
      const mirrored = createdWith(aliceOnBWs, 'for bob only');
      expect(mirrored).toHaveLength(1);
      expect((mirrored[0]!.message as { dmChannelId: string }).dmChannelId).toBe(bobDmOnB);

      // POSITIVE CONTROL: carol's socket does receive what alice sends her.
      const toCarol = await sendDmMessage(A, alice.token, carolDm, { content: 'control to carol' });
      expect(toCarol.status).toBe(201);
      expect(await waitUntil(() => createdWith(carolWs, 'control to carol').length > 0, 8_000)).toBe(true);

      await settleRelays();

      // carol was never sent the message, on either instance's socket...
      expect(createdWith(carolWs, 'for bob only')).toEqual([]);
      // ...A stores it once, in the alice–bob conversation only...
      const onA = readDb(A, db =>
        db.prepare('SELECT dm_channel_id AS ch FROM dm_messages WHERE content = ?').all('for bob only') as { ch: string }[],
      );
      expect(onA.map(r => r.ch)).toEqual([bobDmOnA]);
      // ...and carol's view of her DM with alice does not contain it.
      const carolView = await listDmMessages(A, carol.token, carolDm);
      expect(carolView.map(m => m.content)).toContain('hi alice');
      expect(carolView.map(m => m.content)).not.toContain('for bob only');
    } finally {
      carolWs.close();
      aliceOnBWs.close();
    }
  });
});
