import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  readDb,
  sendDmMessage,
  settleRelays,
  waitUntil,
  withWritableDb,
  type PeeredHarness,
  type RelayPostResult,
} from './helpers/federationE2E.js';
import { dmWithHomeUser, groupDelivered, queuedOnce, rowFor } from './helpers/dmScope.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsCapture } from './helpers/wsListener.js';
import { initiatePeering } from './helpers/realHandshake.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances over real HTTP; the 5s unit default is too tight.
vi.setConfig({ testTimeout: 45_000 });

/**
 * ── e2e: how A names and fills the rows of users homed elsewhere ────────────
 *
 * #354: a handle another row already holds gets a suffix no handle can
 * contain, so it never shadows a later real user with that handle, and the
 * suffixed row moves to its handle once the holder is gone.
 * #355: a relayed profile snapshot never overwrites a stored field; a third
 * instance's stale replica cannot flip it or cause an announcement.
 *
 * Topology (IDENTITY profile; H peered with R and with C, and C with R):
 *   bob, kai*    — native on H, the home of the users R names
 *   alice        — native on R, the receiver's user watching over WebSocket
 *   cora         — native on C, a third instance with its own replica of bob
 * R is the receiver throughout. H's and C's real events are read from their
 * outboxes and posted, signed, to R. The harness peers the first instance
 * with each other one; C then peers with R through the real handshake.
 */

let h: PeeredHarness;
let H: SpawnedInstance;
let R: SpawnedInstance;
let C: SpawnedInstance;
let alice: TestUser;
let aliceWs: WsCapture;

function relayFrom(sender: SpawnedInstance): (events: FederationRelayEvent[]) => Promise<RelayPostResult> {
  return (events) => postSignedRelay(R, identityOrigin(sender), peerSecretOn(R, identityOrigin(sender)), events);
}

/** Register a native user on `inst` under exactly `username`. */
async function registerExact(inst: SpawnedInstance, username: string): Promise<TestUser> {
  const password = `pw_${crypto.randomBytes(8).toString('hex')}`;
  const res = await fetch(`${inst.origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`register ${username} failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { user: { id: string }; token: string };
  return { id: data.user.id, username, password, token: data.token, origin: inst.origin };
}

async function patchMe(inst: SpawnedInstance, user: TestUser, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${inst.origin}/api/users/@me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH @me failed: ${res.status} ${await res.text()}`);
}

/**
 * `sender` (native on H or C) sends a message in `channelId` on its instance,
 * and R receives the create event the sender really queued.
 */
async function deliverMessage(inst: SpawnedInstance, sender: TestUser, channelId: string, content: string): Promise<void> {
  const sent = await sendDmMessage(inst, sender.token, channelId, { content });
  if (!sent.id) throw new Error(`send failed: ${sent.status} ${sent.error}`);
  const event = queuedOnce(inst, channelId, 'create').find(e => e.messageId === sent.id);
  if (!event) throw new Error(`${inst.domain} queued no create for ${sent.id}`);
  const res = await relayFrom(inst)([event]);
  if (!res.body?.accepted.includes(event.messageId)) throw new Error(`create not accepted by R: ${res.raw}`);
}

function rowOnR(homeUserId: string): { id: string; username: string; avatarColor: string | null } | undefined {
  return readDb(R, db => db.prepare(
    'SELECT id, username, avatar_color AS avatarColor FROM users WHERE home_user_id = ? AND is_deleted = 0',
  ).get(homeUserId) as { id: string; username: string; avatarColor: string | null } | undefined);
}

function userUpdatesFor(rowId: string): Array<{ username: string; avatarColor: string | null }> {
  return aliceWs.events
    .filter(e => e.type === 'user_updated' && (e.user as { id?: string } | undefined)?.id === rowId)
    .map(e => e.user as { username: string; avatarColor: string | null });
}

beforeAll(async () => {
  h = await bootIdentityPeered(2);
  H = h.home;
  R = h.remotes[0]!;
  C = h.remotes[1]!;
  const peered = await initiatePeering(C, h.remoteAdminTokens[1]!, R);
  if (peered.status !== 200 || peered.body.verified !== true) {
    throw new Error(`handshake C -> R failed: ${peered.status} ${JSON.stringify(peered.body)}`);
  }
  alice = await registerLocal(R, 'alice');
  aliceWs = await connectWs(R.origin, alice.token);
}, 120_000);

afterAll(async () => {
  aliceWs?.close();
  await h?.cleanup();
});

describe('suffixed names of users homed elsewhere (#354)', () => {
  it('a suffixed name never shadows a later real user, and moves to the handle once the holder is gone', async () => {
    const base = `k${crypto.randomBytes(3).toString('hex')}`;
    const kai = await registerExact(H, base);
    const kaiOne = await registerExact(H, `${base}_1`);

    // R still holds a replica of an earlier `<base>` on H, deleted there
    // without the deletion reaching R.
    const staleId = 'e2e-stale-kai';
    withWritableDb(R, db => {
      db.prepare(`INSERT INTO users (id, username, password_hash, status, is_admin, home_instance, home_user_id, created_at)
        VALUES (?, ?, '!federation-replicated', 'offline', 0, ?, ?, ?)`)
        .run(staleId, `${base}@${H.domain}`, H.domain, '1999999999999999999', Date.now());
    });

    const kaiDm = await dmWithHomeUser(H, kai.token, alice, R);
    await deliverMessage(H, kai, kaiDm, 'hello from kai');
    expect(rowOnR(kai.id)?.username).toBe(`${base}~1@${H.domain}`);

    const kaiOneDm = await dmWithHomeUser(H, kaiOne.token, alice, R);
    await deliverMessage(H, kaiOne, kaiOneDm, 'hello from kai_1');
    expect(rowOnR(kaiOne.id)?.username).toBe(`${base}_1@${H.domain}`);

    // The deletion reaches R: the stale row is tombstoned and frees the name.
    withWritableDb(R, db => {
      db.prepare(`UPDATE users SET username = ?, is_deleted = 1 WHERE id = ?`).run(`!deleted:${staleId}`, staleId);
    });

    const kaiRow = rowOnR(kai.id)!.id;
    await deliverMessage(H, kai, kaiDm, 'kai again');
    expect(rowOnR(kai.id)?.username).toBe(`${base}@${H.domain}`);
    expect(rowOnR(kaiOne.id)?.username).toBe(`${base}_1@${H.domain}`);
    expect(await waitUntil(() => userUpdatesFor(kaiRow).some(u => u.username === `${base}@${H.domain}`), 5_000)).toBe(true);
  });
});

describe('relayed profile snapshots (#355)', () => {
  it('a stale snapshot relayed by a third instance neither flips avatarColor nor announces anything', async () => {
    const bob = await registerLocal(H, 'bob');
    await patchMe(H, bob, { avatarColor: 'mint' });

    // bob's home relays him to R first: R's row takes his colour.
    const bobDm = await dmWithHomeUser(H, bob.token, alice, R);
    await deliverMessage(H, bob, bobDm, 'bob says hi');
    expect(rowOnR(bob.id)?.avatarColor).toBe('mint');
    const bobOnR = rowOnR(bob.id)!.id;

    // C holds its own replica of bob, with a colour bob no longer has.
    const cora = await registerLocal(C, 'cora');
    const aliceOnC = await dmWithHomeUser(C, cora.token, alice, R).then(() => rowFor(C, alice.id));
    await dmWithHomeUser(C, cora.token, bob, H);
    const bobOnC = rowFor(C, bob.id);
    withWritableDb(C, db => {
      db.prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run('rose', bobOnC);
    });
    const [groupOnC] = await groupDelivered(C, cora, [
      { id: aliceOnC, homeUserId: alice.id, homeInstance: R.domain },
      { id: bobOnC, homeUserId: bob.id, homeInstance: H.domain },
    ], relayFrom(C));
    const announcedBefore = userUpdatesFor(bobOnR).length;

    // Messages alternate between C (stale colour) and bob's home.
    await deliverMessage(C, cora, groupOnC, 'cora 1');
    expect(rowOnR(bob.id)?.avatarColor).toBe('mint');
    await deliverMessage(H, bob, bobDm, 'bob 2');
    await deliverMessage(C, cora, groupOnC, 'cora 2');
    expect(rowOnR(bob.id)?.avatarColor).toBe('mint');

    await settleRelays();
    expect(userUpdatesFor(bobOnR).slice(announcedBefore)).toEqual([]);
  });
});
