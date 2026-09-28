import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  bootTransportPeered,
  readDb,
  waitUntil,
  withWritableDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsCapture, type WsEvent } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances, real sockets, worker-driven S2S delivery.
vi.setConfig({ testTimeout: 45_000 });

/**
 * ── e2e gate for #340: a new friend's running game shows at once ───────────
 *
 * bob (native on B) is already playing when alice (native on A) and he become
 * friends. Presence relays fire only on change, and A had no row for bob when
 * the game started, so before the fix A never learned of it: alice's friends
 * views showed bob online with no activity until his game changed.
 *
 * Now accepting the request makes B send bob's current presence to A, A keeps
 * it on its row for bob, and alice's socket gets a presence_update that names
 * bob's home identity, so her client keys it like every other view of bob.
 *
 * TRANSPORT profile, so the relays are really delivered by the outbox worker.
 * The replicated rows and the pending requests the friend-request flow would
 * create are planted after bob's game relay has been delivered, which is the
 * order of events in the issue (see relay-scoping suite for why loopback
 * needs planted rows).
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let alice: TestUser;
let bob: TestUser;
const STUB_BOB_ON_A = 'e2e-stub-bob-on-a';
const STUB_ALICE_ON_B = 'e2e-stub-alice-on-b';
const sockets: WsCapture[] = [];

function track(ws: WsCapture): WsCapture {
  sockets.push(ws);
  return ws;
}

/** Queued presence relays about `userId` that carry the game. */
function pendingGameRelays(inst: SpawnedInstance, userId: string): number {
  return readDb(inst, db => (db.prepare(
    "SELECT COUNT(*) AS n FROM federation_outbox WHERE event_type = 'presence_update' AND entity_id = ? AND payload LIKE '%Factorio%'",
  ).get(userId) as { n: number }).n);
}

function presenceAbout(ws: WsCapture, userId: string): WsEvent[] {
  return ws.events.filter(e => e.type === 'presence_update' && e.userId === userId);
}

beforeAll(async () => {
  h = await bootTransportPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  alice = await registerLocal(A, 'alice');
  bob = await registerLocal(B, 'bob');
}, 120_000);

function plantPendingFriendship(): void {
  const now = Date.now();
  withWritableDb(A, db => {
    db.prepare(`INSERT INTO users (id, username, display_name, password_hash, status, is_admin, home_instance, home_user_id, created_at)
      VALUES (?, ?, ?, '!federation-replicated', 'online', 0, ?, ?, ?)`)
      .run(STUB_BOB_ON_A, `${bob.username}@${B.domain}`, bob.username, B.origin, bob.id, now);
    db.prepare("INSERT INTO friend_requests (id, from_id, to_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .run('e2e-req-a', alice.id, STUB_BOB_ON_A, now);
  });
  withWritableDb(B, db => {
    db.prepare(`INSERT INTO users (id, username, display_name, password_hash, status, is_admin, home_instance, home_user_id, created_at)
      VALUES (?, ?, ?, '!federation-replicated', 'online', 0, ?, ?, ?)`)
      .run(STUB_ALICE_ON_B, `${alice.username}@${A.domain}`, alice.username, A.origin, alice.id, now);
    db.prepare("INSERT INTO friend_requests (id, from_id, to_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .run('e2e-req-b', STUB_ALICE_ON_B, bob.id, now);
  });
}

afterAll(async () => {
  for (const ws of sockets) ws.close();
  if (h) await h.cleanup();
}, 30_000);

describe("#340: a new friend's current activity", () => {
  it("reaches the friend's home and the friend's socket when the request is accepted", async () => {
    // bob starts playing while A has no row for him: B relays the change, and
    // A drops it (no replicated row to apply it to).
    const bobWs = track(await connectWs(B.origin, bob.token));
    bobWs.send({ type: 'activity_update', activities: [{ type: 'playing', name: 'Factorio' }] });
    expect(await waitUntil(() => pendingGameRelays(B, bob.id) > 0, 10_000, 50)).toBe(true);
    expect(await waitUntil(() => pendingGameRelays(B, bob.id) === 0, 15_000)).toBe(true);

    // Then alice sends him a request, which gives A a row for bob.
    plantPendingFriendship();
    const aliceWs = track(await connectWs(A.origin, alice.token));

    const res = await fetch(`${B.origin}/api/social/requests/e2e-req-b`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ status: 'accepted' }),
    });
    expect(res.status).toBe(200);

    const sawGame = await waitUntil(() => presenceAbout(aliceWs, STUB_BOB_ON_A).some(e =>
      Array.isArray(e.activities) && (e.activities as Array<{ name?: string }>).some(a => a.name === 'Factorio'),
    ), 20_000);
    expect(sawGame).toBe(true);
    const withGame = presenceAbout(aliceWs, STUB_BOB_ON_A).find(e => Array.isArray(e.activities) && e.activities.length > 0)!;
    expect(withGame.homeUserId).toBe(bob.id);
    expect(withGame.homeInstance).toBe(B.origin);
  });

  it("is in alice's next ready payload", async () => {
    const aliceWs = track(await connectWs(A.origin, alice.token));
    const ready = aliceWs.events.find(e => e.type === 'ready') as
      { userActivities?: Record<string, Array<{ name: string }>>; userActivityIdentities?: Record<string, unknown> } | undefined;
    expect(ready?.userActivities?.[STUB_BOB_ON_A]?.[0]?.name).toBe('Factorio');
    expect(ready?.userActivityIdentities?.[STUB_BOB_ON_A]).toEqual({ homeUserId: bob.id, homeInstance: B.origin });
  });
});
