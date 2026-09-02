import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  createDm,
  sendDmMessage,
  listDmMessages,
  readDb,
  withWritableDb,
  type DmMessageView,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import { connectWs } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances over real HTTP; the 5s unit default is too tight. See
// federation-identity-deletion.test.ts.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate for `54d34a00` — a DM reply must target its own channel ──────────
 *
 * Two halves, and the fix changed both:
 *   CREATE — `POST /api/dm/:id/messages` and the WebSocket `dm_message_create`
 *     handler both look the reply target up scoped to the destination channel
 *     and answer "Invalid reply target" without inserting.
 *   READ — all four DM read paths resolve `replyTo` through
 *     `fetchDmReplyToMessages(dmChannelId, rows)`, so a row written BEFORE the
 *     create-time check existed hydrates as `replyTo: null` instead of leaking
 *     a message from a conversation the reader is not in.
 *
 * The read half is only observable against a row that already carries an
 * out-of-channel `replyToId`, which the create path now refuses to produce. The
 * suite writes exactly that one row directly (see `plantCrossChannelReply`) —
 * that is the legacy state the read fix exists for, not a shortcut around the
 * create fix, which is asserted separately over real HTTP and real WS.
 *
 * The federated leg checks the relay side of the same rule: an inbound relayed
 * message must not carry a reply pointer into a local channel at all.
 *
 * ── Non-vacuity ──────────────────────────────────────────────────────────────
 * Every "not hydrated / not inserted" assertion is paired, in the same test,
 * with a same-channel reply that IS hydrated or IS inserted through the very
 * same endpoint. A read path that had stopped returning `replyTo` altogether —
 * or a create path that rejected every reply — fails the control rather than
 * passing the negative for free.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let secret: string;

let u1: TestUser;
let u2: TestUser;
let u3: TestUser;

/** u1 <-> u2. Holds the message that must not be reachable from `dmY`. */
let dmX: string;
/** u1 <-> u3. The channel replies are posted into. */
let dmY: string;

/** A message living in dmX. */
let foreignMessageId: string;
/** A message living in dmY, the legitimate reply target. */
let localTargetId: string;

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  secret = peerSecretOn(B, identityOrigin(A));

  u1 = await registerLocal(A, 'u1');
  u2 = await registerLocal(A, 'u2');
  u3 = await registerLocal(A, 'u3');

  dmX = await createDm(A, u1.token, u2.id);
  dmY = await createDm(A, u1.token, u3.id);

  const foreign = await sendDmMessage(A, u1.token, dmX, { content: 'secret-in-dmX' });
  if (foreign.status !== 201 || !foreign.id) throw new Error(`seed dmX failed: ${foreign.status}`);
  foreignMessageId = foreign.id;

  const local = await sendDmMessage(A, u1.token, dmY, { content: 'target-in-dmY' });
  if (local.status !== 201 || !local.id) throw new Error(`seed dmY failed: ${local.status}`);
  localTargetId = local.id;
}, 90_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

/**
 * Write a dmY message whose `replyToId` points into dmX.
 *
 * This is the legacy row shape the read-path fix exists for: the create paths no
 * longer produce it, so it cannot be made over HTTP. Only the pointer is planted
 * — hydration itself runs through the real endpoints.
 */
function plantCrossChannelReply(content: string): string {
  const id = `e2e-planted-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  withWritableDb(A, db => {
    db.prepare(`
      INSERT INTO dm_messages (id, dm_channel_id, user_id, content, type, reply_to_id, created_at)
      VALUES (?, ?, ?, ?, 'user', ?, ?)
    `).run(id, dmY, u1.id, content, foreignMessageId, Date.now());
  });
  return id;
}

function findView(views: DmMessageView[], id: string): DmMessageView {
  const found = views.find(v => v.id === id);
  if (!found) throw new Error(`message ${id} not present in response`);
  return found;
}

describe('federation e2e — DM replies are confined to their own channel (54d34a00)', () => {
  it('setup control: the two DM channels are distinct and each holds its seeded message', () => {
    expect(dmX).not.toBe(dmY);
    const rows = readDb(A, db =>
      db
        .prepare('SELECT id, dm_channel_id AS ch FROM dm_messages WHERE id IN (?, ?)')
        .all(foreignMessageId, localTargetId) as { id: string; ch: string }[],
    );
    expect(rows.find(r => r.id === foreignMessageId)?.ch).toBe(dmX);
    expect(rows.find(r => r.id === localTargetId)?.ch).toBe(dmY);
  });

  it('REST create refuses a reply pointing at another channel, and accepts one in the same channel', async () => {
    const before = readDb(A, db =>
      (db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE dm_channel_id = ?').get(dmY) as { n: number }).n,
    );

    const crossChannel = await sendDmMessage(A, u1.token, dmY, {
      content: 'rest-cross-channel-reply',
      replyToId: foreignMessageId,
    });
    expect(crossChannel.status).toBe(400);
    expect(crossChannel.error).toBe('Invalid reply target');

    // POSITIVE CONTROL — the identical call with an in-channel target succeeds,
    // so the 400 above is about the target's channel, not about replies at all.
    const sameChannel = await sendDmMessage(A, u1.token, dmY, {
      content: 'rest-same-channel-reply',
      replyToId: localTargetId,
    });
    expect(sameChannel.status).toBe(201);
    expect(sameChannel.id).toBeTruthy();

    // Exactly one row was added: the refused one never reached the table.
    const after = readDb(A, db =>
      (db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE dm_channel_id = ?').get(dmY) as { n: number }).n,
    );
    expect(after).toBe(before + 1);
    expect(
      readDb(A, db =>
        db.prepare('SELECT id FROM dm_messages WHERE content = ?').all('rest-cross-channel-reply'),
      ),
    ).toEqual([]);
  });

  it('the WebSocket create path refuses a cross-channel reply, and accepts a same-channel one', async () => {
    const ws = await connectWs(A.origin, u1.token);
    try {
      ws.send({
        type: 'dm_message_create',
        dmChannelId: dmY,
        content: 'ws-cross-channel-reply',
        replyToId: foreignMessageId,
      });
      const err = await ws.waitForEvent('error', 8_000);
      expect(err.message).toBe('Invalid reply target');

      // POSITIVE CONTROL on the same socket: an in-channel reply broadcasts.
      ws.send({
        type: 'dm_message_create',
        dmChannelId: dmY,
        content: 'ws-same-channel-reply',
        replyToId: localTargetId,
      });
      const created = await ws.waitForEvent('dm_message_created', 8_000);
      expect(created).toBeTruthy();
    } finally {
      ws.close();
    }

    expect(
      readDb(A, db =>
        db.prepare('SELECT id FROM dm_messages WHERE content = ?').all('ws-cross-channel-reply'),
      ),
    ).toEqual([]);
    expect(
      readDb(A, db =>
        db.prepare('SELECT id FROM dm_messages WHERE content = ?').all('ws-same-channel-reply'),
      ),
    ).toHaveLength(1);
  });

  it('the message list hydrates an out-of-channel replyTo as null, and an in-channel one as the message', async () => {
    const plantedId = plantCrossChannelReply('planted-list-hydration');
    const goodReply = await sendDmMessage(A, u1.token, dmY, {
      content: 'good-list-hydration',
      replyToId: localTargetId,
    });
    expect(goodReply.status).toBe(201);

    const views = await listDmMessages(A, u1.token, dmY);

    // POSITIVE CONTROL first: this read path does resolve replyTo.
    expect(findView(views, goodReply.id!).replyTo?.id).toBe(localTargetId);
    // The planted row's pointer is not resolved — the dmX message does not leak.
    expect(findView(views, plantedId).replyTo).toBeNull();
  });

  it('DM search hydrates an out-of-channel replyTo as null, and an in-channel one as the message', async () => {
    const plantedId = plantCrossChannelReply('planted-search-hydration');
    const goodReply = await sendDmMessage(A, u1.token, dmY, {
      content: 'good-search-hydration',
      replyToId: localTargetId,
    });
    expect(goodReply.status).toBe(201);

    const search = async (q: string): Promise<DmMessageView[]> => {
      const res = await fetch(`${A.origin}/api/dm/${dmY}/search?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${u1.token}` },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { results: DmMessageView[] };
      return data.results;
    };

    const good = await search('good-search-hydration');
    expect(good).toHaveLength(1);
    expect(good[0]!.replyTo?.id).toBe(localTargetId); // POSITIVE CONTROL

    const planted = await search('planted-search-hydration');
    expect(planted).toHaveLength(1);
    expect(planted[0]!.id).toBe(plantedId);
    expect(planted[0]!.replyTo).toBeNull();
  });

  it('messages-around hydrates an out-of-channel replyTo as null, and an in-channel one as the message', async () => {
    const plantedId = plantCrossChannelReply('planted-around-hydration');
    const goodReply = await sendDmMessage(A, u1.token, dmY, {
      content: 'good-around-hydration',
      replyToId: localTargetId,
    });
    expect(goodReply.status).toBe(201);

    const res = await fetch(`${A.origin}/api/dm/${dmY}/messages/around?messageId=${plantedId}`, {
      headers: { Authorization: `Bearer ${u1.token}` },
    });
    expect(res.status).toBe(200);
    const views = await res.json() as DmMessageView[];

    expect(findView(views, goodReply.id!).replyTo?.id).toBe(localTargetId); // POSITIVE CONTROL
    expect(findView(views, plantedId).replyTo).toBeNull();
  });

  it('a relayed inbound message never carries a reply pointer into a local channel', async () => {
    const messageId = `e2e-reply-relay-${Date.now()}`;
    const bob = await registerLocal(B, 'replybob');
    const content = `relayed-with-replyto-${messageId}`;

    // The wire carries a replyToId naming a message that exists on B. The
    // receiver must not adopt it: a remote id is meaningless in a local channel.
    const foreignOnB = readDb(B, db =>
      db.prepare('SELECT id FROM dm_messages LIMIT 1').get() as { id: string } | undefined,
    );

    const event: FederationRelayEvent = {
      eventType: 'create',
      contextType: 'dm',
      messageId,
      encryptionVersion: 0,
      timestamp: Date.now(),
      participants: [
        { homeUserId: '900000000000000201', homeInstance: A.domain, profile: { username: 'relayalice' } },
        { homeUserId: bob.id, homeInstance: B.domain, profile: { username: bob.username } },
      ],
      message: {
        userId: '900000000000000201',
        homeUserId: '900000000000000201',
        homeInstance: A.domain,
        content,
        replyToId: foreignOnB?.id ?? 'some-remote-message-id',
        editedAt: null,
        createdAt: Date.now(),
      },
    };

    const res = await postSignedRelay(B, identityOrigin(A), secret, [event]);
    // POSITIVE CONTROL: the relay really was accepted and really did insert —
    // so "reply_to_id is null" below is a statement about the stored row, not
    // about a message that never arrived.
    expect(res.status).toBe(200);
    expect(res.body?.accepted).toContain(messageId);

    const stored = readDb(B, db =>
      db.prepare('SELECT reply_to_id AS replyToId FROM dm_messages WHERE content = ?').get(content) as
        { replyToId: string | null } | undefined,
    );
    expect(stored).toBeDefined();
    expect(stored!.replyToId).toBeNull();
  });
});
