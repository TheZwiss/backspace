import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  listDmMessages,
  peerSecretOn,
  postSignedRelay,
  readDb,
  sendDmMessage,
  withWritableDb,
  type PeeredHarness,
  type RelayPostResult,
} from './helpers/federationE2E.js';
import {
  channelByFederatedId,
  dmWithHomeUser,
  groupDelivered,
  memberIds,
  queuedOnce,
  rowFor,
} from './helpers/dmScope.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances over real HTTP; the 5s unit default is too tight.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate: mentions in a relayed DM name the receiver's users (#347) ──────
 *
 * A `<@id>` token carries an id on the instance the author wrote it on. The
 * relay used to copy content verbatim, so on every other instance the token
 * named an id that meant nobody there and the client showed "Unknown User".
 *
 * A relayed create or edit now carries `message.mentions`: each mentioned id
 * with the federated identity (home user id + home instance) it stands for on
 * the sender. The receiver resolves each identity to its own row and rewrites
 * the token to that row's id before storing the content. A sender without the
 * list is stored verbatim, as before.
 *
 * Topology (IDENTITY profile, so B's inbound relay handling is fully real):
 *   alice — native on A
 *   carol — native on A
 *   bob   — native on B
 * alice's 1-on-1 with bob, and alice's group with bob and carol. alice writes
 * on A; A's queued events are posted, signed, to B.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let secretOnB: string;

let alice: TestUser;
let carol: TestUser;
let bob: TestUser;

let pairOnA: string;
let pairOnB: string;
let groupOnA: string;
let groupOnB: string;

/** A's row for bob, B's rows for alice and carol. */
let bobOnA: string;
let aliceOnB: string;
let carolOnB: string;

function relayToB(events: FederationRelayEvent[]): Promise<RelayPostResult> {
  return postSignedRelay(B, identityOrigin(A), secretOnB, events);
}

/** alice sends on A; returns A's id and the create event A queued for it. */
async function aliceSendsOnA(dmOnA: string, content: string): Promise<[string, FederationRelayEvent]> {
  const sent = await sendDmMessage(A, alice.token, dmOnA, { content });
  if (sent.status !== 201 || !sent.id) throw new Error(`send on A failed: ${sent.status} ${sent.error}`);
  const create = queuedOnce(A, dmOnA, 'create').find(e => e.messageId === sent.id);
  if (!create) throw new Error(`A queued no create for ${sent.id}`);
  return [sent.id, create];
}

/** B's copy of the message A created as `idOnA`. */
function copyOnB(idOnA: string): { id: string; content: string | null; dmChannelId: string } | undefined {
  return readDb(B, db =>
    db.prepare(`
      SELECT id, content, dm_channel_id AS dmChannelId FROM dm_messages
      WHERE source_instance = ? AND source_message_id = ?
    `).get(identityOrigin(A), idOnA) as { id: string; content: string | null; dmChannelId: string } | undefined,
  );
}

async function deliver(event: FederationRelayEvent): Promise<void> {
  const res = await relayToB([event]);
  if (!res.body?.accepted.includes(event.messageId)) throw new Error(`${event.eventType} not accepted: ${res.raw}`);
}

/** The `<@id>` ids in `content`, in order. */
function tokenIds(content: string | null): string[] {
  return [...(content ?? '').matchAll(/<@([a-zA-Z0-9_-]+)>/g)].map(m => m[1]!);
}

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  secretOnB = peerSecretOn(B, identityOrigin(A));

  alice = await registerLocal(A, 'alice');
  carol = await registerLocal(A, 'carol');
  bob = await registerLocal(B, 'bob');

  pairOnA = await dmWithHomeUser(A, alice.token, bob, B);
  bobOnA = rowFor(A, bob.id);

  const [openerId, opener] = await aliceSendsOnA(pairOnA, 'opener from alice');
  await deliver(opener);
  pairOnB = copyOnB(openerId)!.dmChannelId;
  aliceOnB = rowFor(B, alice.id);

  let fid: string;
  [groupOnA, fid] = await groupDelivered(A, alice, [
    { id: bobOnA, homeUserId: bob.id, homeInstance: B.domain },
    { id: carol.id },
  ], relayToB);
  groupOnB = channelByFederatedId(B, fid)!;
  carolOnB = rowFor(B, carol.id);

  // A's worker would drop what B accepted. Left queued, an edit below would
  // coalesce into its create instead of going out as an update.
  withWritableDb(A, db => {
    db.prepare('DELETE FROM federation_outbox WHERE context_id IN (?, ?)').run(pairOnA, groupOnA);
  });
}, 120_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — a relayed DM names the receiver\'s users in its mentions', () => {
  it('setup control: the ids differ per instance', () => {
    expect(bobOnA).not.toBe(bob.id);
    expect(aliceOnB).not.toBe(alice.id);
    expect(carolOnB).not.toBe(carol.id);
    expect(memberIds(B, pairOnB)).toEqual([aliceOnB, bob.id].sort());
    expect(memberIds(B, groupOnB)).toEqual([aliceOnB, bob.id, carolOnB].sort());
  });

  it('a 1-on-1 create: B stores its own ids for bob and for alice', async () => {
    const [idOnA, create] = await aliceSendsOnA(pairOnA, `hey <@${bobOnA}>, it is <@${alice.id}>`);
    await deliver(create);

    const copy = copyOnB(idOnA)!;
    expect(copy.content).toBe(`hey <@${bob.id}>, it is <@${aliceOnB}>`);

    // What bob's client reads from B: every token names a member of the DM there.
    const served = (await listDmMessages(B, bob.token, pairOnB)).find(m => m.id === copy.id)!;
    expect(served.content).toBe(copy.content);
    for (const id of tokenIds(served.content)) expect(memberIds(B, pairOnB)).toContain(id);
  });

  it('a group create: B stores its own ids for bob (native on B) and carol (native on A)', async () => {
    const [idOnA, create] = await aliceSendsOnA(groupOnA, `<@${bobOnA}> meet <@${carol.id}>`);
    await deliver(create);

    const copy = copyOnB(idOnA)!;
    expect(copy.content).toBe(`<@${bob.id}> meet <@${carolOnB}>`);
    for (const id of tokenIds(copy.content)) expect(memberIds(B, groupOnB)).toContain(id);
  });

  it('an edit: B rewrites the new content, and leaves tokens inside code as written', async () => {
    const [idOnA, create] = await aliceSendsOnA(groupOnA, `first <@${bobOnA}>`);
    await deliver(create);
    withWritableDb(A, db => {
      db.prepare('DELETE FROM federation_outbox WHERE entity_id = ?').run(idOnA);
    });

    const edited = `now <@${carol.id}> and \`<@${bobOnA}>\``;
    const res = await fetch(`${A.origin}/api/dm/messages/${idOnA}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ content: edited }),
    });
    expect(res.status).toBe(200);
    const update = queuedOnce(A, groupOnA, 'update').find(e => e.messageId === idOnA);
    expect(update).toBeDefined();
    await deliver(update!);

    expect(copyOnB(idOnA)?.content).toBe(`now <@${carolOnB}> and \`<@${bobOnA}>\``);
  });

  it('a sender without the list (older peer): B stores the content as sent', async () => {
    const content = `old peer <@${bobOnA}>`;
    const [idOnA, create] = await aliceSendsOnA(pairOnA, content);
    const withoutList: FederationRelayEvent = { ...create, message: { ...create.message! } };
    delete withoutList.message!.mentions;
    await deliver(withoutList);

    expect(copyOnB(idOnA)?.content).toBe(content);
  });
});
