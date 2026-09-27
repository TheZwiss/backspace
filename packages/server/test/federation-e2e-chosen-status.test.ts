import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  bootTransportPeered,
  readDb,
  waitUntil,
  withWritableDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { createFederatedUser, registerLocal, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsCapture } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances, real sockets, worker-driven S2S delivery. The disconnect path
// has a 5s grace timer, so these tests wait longer than the unit default.
vi.setConfig({ testTimeout: 45_000 });

/**
 * ── e2e gate for #298 follow-up — the chosen status survives reconnects ──────
 *
 * Before `users.chosen_status`, socket auth wrote `status = 'online'` and the
 * ready payload carried it, so Do Not Disturb (and idle) silently reset on every
 * reconnect, app restart and server restart. Now:
 * - a manual change writes `chosen_status` (and the live `status` while connected);
 * - auth publishes the chosen status to the user, to local observers and to peers;
 * - 'offline' still means no connection;
 * - on a peer, the user's replicated row keeps the home instance's projection
 *   when the user's own connection to that peer authenticates, and its local
 *   `chosen_status` copy is never used.
 *
 * TRANSPORT profile so the presence relay is really delivered by the outbox
 * worker (see helpers/federationE2E.ts).
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
/** Native on A, with a federated account on B. */
let danaOnA: TestUser;
let danaOnB: TestUser;
/** Native on A; a friend of dana, observing her presence over the socket. */
let olle: TestUser;
const sockets: WsCapture[] = [];

function track(ws: WsCapture): WsCapture {
  sockets.push(ws);
  return ws;
}

function statusRow(inst: SpawnedInstance, id: string): { status: string | null; chosen: string } | undefined {
  return readDb(inst, db =>
    db.prepare('SELECT status, chosen_status AS chosen FROM users WHERE id = ?').get(id) as
      { status: string | null; chosen: string } | undefined,
  );
}

async function setStatus(inst: SpawnedInstance, user: TestUser, status: string): Promise<Response> {
  return fetch(`${inst.origin}/api/users/@me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({ status }),
  });
}

function readyStatus(ws: WsCapture): unknown {
  const ready = ws.events.find(e => e.type === 'ready') as { user?: { status?: unknown } } | undefined;
  return ready?.user?.status;
}

function presenceFor(ws: WsCapture, userId: string): string[] {
  return ws.events
    .filter(e => e.type === 'presence_update' && e.userId === userId)
    .map(e => String(e.status));
}

beforeAll(async () => {
  h = await bootTransportPeered(1);
  A = h.home;
  B = h.remotes[0]!;

  ({ homeUser: danaOnA, remoteUser: danaOnB } = await createFederatedUser(A, B, 'dana'));
  olle = await registerLocal(A, 'olle');

  withWritableDb(A, db => {
    const now = Date.now();
    // Friendship is what makes olle a presence broadcast target for dana.
    db.prepare('INSERT INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)')
      .run(danaOnA.id, olle.id, now);
  });
  withWritableDb(B, db => {
    // Point dana's replicated row at the origin B knows A by, so the presence
    // relay's attribution check matches (the loopback stand-in for production's
    // single https://DOMAIN; see relay-scoping suite).
    db.prepare('UPDATE users SET home_instance = ? WHERE id = ?').run(A.origin, danaOnB.id);
  });
}, 120_000);

afterAll(async () => {
  for (const ws of sockets) ws.close();
  if (h) await h.cleanup();
}, 30_000);

describe('chosen status (#298 follow-up)', () => {
  it('rejects offline as a chosen status', async () => {
    const res = await setStatus(A, danaOnA, 'offline');
    expect(res.status).toBe(400);
  });

  it('keeps dnd across a full disconnect: offline while gone, dnd again on the next auth', async () => {
    const observer = track(await connectWs(A.origin, olle.token));
    const first = track(await connectWs(A.origin, danaOnA.token));
    expect(readyStatus(first)).toBe('online');

    const res = await setStatus(A, danaOnA, 'dnd');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status?: string }).status).toBe('dnd');
    expect(statusRow(A, danaOnA.id)).toEqual({ status: 'dnd', chosen: 'dnd' });

    first.close();
    // The 5s disconnect grace, then finalizeDisconnect: live status offline,
    // the choice untouched.
    expect(await waitUntil(() => statusRow(A, danaOnA.id)?.status === 'offline', 15_000)).toBe(true);
    expect(statusRow(A, danaOnA.id)).toEqual({ status: 'offline', chosen: 'dnd' });
    expect(presenceFor(observer, danaOnA.id).at(-1)).toBe('offline');

    const second = track(await connectWs(A.origin, danaOnA.token));
    expect(readyStatus(second)).toBe('dnd');
    expect(statusRow(A, danaOnA.id)).toEqual({ status: 'dnd', chosen: 'dnd' });
    expect(await waitUntil(() => presenceFor(observer, danaOnA.id).at(-1) === 'dnd', 5_000)).toBe(true);
  });

  it('comes back as dnd after the boot presence reset', async () => {
    // What resetStalePresenceOnBoot writes after a server restart: the live
    // column only. The next authentication must still publish the choice.
    withWritableDb(A, db => {
      db.prepare("UPDATE users SET status = 'offline' WHERE home_instance IS NULL AND is_deleted = 0").run();
    });
    const ws = track(await connectWs(A.origin, danaOnA.token));
    expect(readyStatus(ws)).toBe('dnd');
    expect(statusRow(A, danaOnA.id)).toEqual({ status: 'dnd', chosen: 'dnd' });
  });

  it("relays the chosen status, so the peer's copy of dana shows dnd", async () => {
    expect(await waitUntil(() => statusRow(B, danaOnB.id)?.status === 'dnd', 15_000)).toBe(true);
  });

  it("keeps the home projection when dana's own connection to the peer authenticates", async () => {
    // A stale local copy on the peer must never stand in for the owner's choice.
    withWritableDb(B, db => {
      db.prepare("UPDATE users SET chosen_status = 'online' WHERE id = ?").run(danaOnB.id);
    });
    const ws = track(await connectWs(B.origin, danaOnB.token));
    expect(readyStatus(ws)).toBe('dnd');
    expect(statusRow(B, danaOnB.id)?.status).toBe('dnd');
  });

  it('relays a status change made over REST to the peer', async () => {
    expect(statusRow(B, danaOnB.id)?.status).toBe('dnd');
    const res = await setStatus(A, danaOnA, 'idle');
    expect(res.status).toBe(200);
    expect(await waitUntil(() => statusRow(B, danaOnB.id)?.status === 'idle', 15_000)).toBe(true);
    // The relay moves the live column only; the peer's chosen_status copy (the
    // decoy planted above) is not written.
    expect(statusRow(B, danaOnB.id)?.chosen).toBe('online');
  });
});
