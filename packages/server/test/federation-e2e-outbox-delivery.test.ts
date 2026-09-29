import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  bootTransportPeered,
  createDm,
  dmMessageContents,
  readDb,
  sendDmMessage,
  waitForOutboxDrained,
  waitForRelay,
  withWritableDb,
  type PeeredHarness,
  type RelayWait,
} from './helpers/federationE2E.js';
import { createFederatedUser, registerLocal, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsCapture } from './helpers/wsListener.js';
import { startRelayTap, type RelayTap } from './helpers/relayTap.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances, real sockets, worker-driven S2S delivery.
vi.setConfig({ testTimeout: 45_000 });

/**
 * ── e2e gate for #367: relays that meet a busy link ──────────────────────────
 *
 * 1. An event queued while the previous one for the same entity is in flight.
 *
 * The outbox keeps one row per (peer, entity) and merges a newer event for the
 * same entity into it. The worker reads a batch, POSTs it, and settles the rows
 * when the answer comes back. A newer event can be merged into a row in that
 * window, after its old content is already on the wire. Before the fix:
 * - an accepted batch deleted the row by id, taking the newer event with it
 *   (a status change right after another one never reached the peer);
 * - a delete merged into an in-flight `create` removed the row as if the
 *   create had never been sent, so the peer kept the message;
 * - an edit merged into an in-flight `create` stayed a `create`, and the row
 *   was then deleted with the accepted create, so the peer kept the old text.
 *
 * B sits behind a `RelayTap` that can hold relay RESPONSES: B has applied the
 * batch, and A has not heard back. That is the in-flight window, held open for
 * as long as the test needs instead of the few milliseconds it lasts on a quiet
 * machine (the CI flake in #367 was this window on a loaded runner).
 *
 * 2. A relay whose first attempt fails. The instance retries it on its backoff
 * schedule, which starts at 30 s in production: longer than any relay wait in
 * these suites. The harness runs every instance with a shortened schedule
 * (`FEDERATION_BACKOFF_DIVISOR`), so the retry lands inside the wait. The tap
 * answers the first attempt 503, as an overloaded peer would.
 *
 * TRANSPORT profile, so the outbox worker really delivers.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let tapB: RelayTap;
let relay: Omit<RelayWait, 'what'>;

/** Native on A, with a federated account on B. */
let danaOnA: TestUser;
let danaOnB: TestUser;
/** Native on A. */
let u1: TestUser;
/** Native on B, with a federated account on A: u1's DM partner. */
let carolOnA: TestUser;
let dmId: string;

const sockets: WsCapture[] = [];

/** Relay events carrying `userId`'s dnd that reached B's tap, failed or not. */
function dndRelaysFor(userId: string): number {
  return tapB.relayEvents().filter(e =>
    e.eventType === 'presence_update' && e.presenceUpdate?.homeUserId === userId && e.presenceUpdate.status === 'dnd',
  ).length;
}

function statusOn(inst: SpawnedInstance, id: string): string | null | undefined {
  return readDb(inst, db =>
    (db.prepare('SELECT status FROM users WHERE id = ?').get(id) as { status: string | null } | undefined)?.status,
  );
}

async function setStatus(user: TestUser, status: string): Promise<void> {
  const res = await fetch(`${A.origin}/api/users/@me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify({ status }),
  });
  expect(res.status).toBe(200);
}

async function messageRequest(method: 'PATCH' | 'DELETE', messageId: string, body?: object): Promise<number> {
  const res = await fetch(`${A.origin}/api/dm/messages/${messageId}`, {
    method,
    headers: {
      Authorization: `Bearer ${u1.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

/**
 * Run `whileInFlight` with B's relay responses held, then release them.
 *
 * A starts with nothing queued or in flight for B, so the batch that carries
 * `send` is the one held (a delivery still settling from an earlier step would
 * otherwise be held instead, and A's worker, which serves B one request at a
 * time, would never send `send` at all). `applied` is how the test sees that B
 * has processed the held batch.
 */
async function withDeliveryInFlight(
  send: () => Promise<void>,
  applied: () => boolean,
  whatApplied: string,
  whileInFlight: () => Promise<void>,
): Promise<void> {
  await waitForOutboxDrained({ ...relay, what: 'A to have nothing queued or in flight for B' });
  const release = tapB.holdRelayResponses();
  try {
    await send();
    await waitForRelay(applied, { ...relay, what: whatApplied });
    await whileInFlight();
  } finally {
    release();
  }
}

beforeAll(async () => {
  tapB = await startRelayTap();
  h = await bootTransportPeered(1, {
    dialOrigins: [tapB.origin],
    beforePeering: (_home, remotes) => tapB.setTarget(remotes[0]!.origin),
  });
  A = h.home;
  B = h.remotes[0]!;
  relay = { sender: A, receiver: B, peerOrigin: tapB.origin };

  ({ homeUser: danaOnA, remoteUser: danaOnB } = await createFederatedUser(A, B, 'dana'));
  withWritableDb(B, db => {
    // B knows A by A's own origin (A signs as it), so dana's replicated row
    // there names that origin: the loopback stand-in for one https://DOMAIN.
    db.prepare('UPDATE users SET home_instance = ? WHERE id = ?').run(A.origin, danaOnB.id);
  });

  u1 = await registerLocal(A, 'u1');
  carolOnA = (await createFederatedUser(B, A, 'carol')).remoteUser;
  withWritableDb(A, db => {
    // A addresses B through the tap, so carol's row on A names the tap.
    db.prepare('UPDATE users SET home_instance = ? WHERE id = ?').run(tapB.origin, carolOnA.id);
  });
  dmId = await createDm(A, u1.token, carolOnA.id);

  // dana's connection is what makes her status changes relay at all.
  sockets.push(await connectWs(A.origin, danaOnA.token));
  await waitForRelay(() => statusOn(B, danaOnB.id) === 'online', {
    ...relay,
    what: "dana's online status on B after she connects to A",
  });
}, 120_000);

afterAll(async () => {
  for (const ws of sockets) ws.close();
  if (tapB) await tapB.close();
  if (h) await h.cleanup();
}, 30_000);

describe('outbox: an event queued while the previous one for the same entity is in flight (#367)', () => {
  it('delivers a status change made while the previous status change is being delivered', async () => {
    await withDeliveryInFlight(
      () => setStatus(danaOnA, 'dnd'),
      () => statusOn(B, danaOnB.id) === 'dnd',
      'dnd on B (the held batch)',
      () => setStatus(danaOnA, 'idle'),
    );
    await waitForRelay(() => statusOn(B, danaOnB.id) === 'idle', {
      ...relay,
      what: 'idle on B, queued while dnd was in flight',
    });
  });

  it('delivers an edit made while the message itself is being delivered', async () => {
    const original = `inflight-edit-original-${Date.now()}`;
    const edited = `inflight-edit-edited-${Date.now()}`;
    let messageId = '';
    await withDeliveryInFlight(
      async () => {
        const sent = await sendDmMessage(A, u1.token, dmId, { content: original });
        expect(sent.status).toBe(201);
        messageId = sent.id!;
      },
      () => dmMessageContents(B).includes(original),
      'the original message on B (the held batch)',
      async () => { expect(await messageRequest('PATCH', messageId, { content: edited })).toBe(200); },
    );
    await waitForRelay(() => dmMessageContents(B).includes(edited), {
      ...relay,
      what: 'the edited text on B, queued while the create was in flight',
    });
    expect(dmMessageContents(B)).not.toContain(original);
  });

  it('delivers a delete made while the message itself is being delivered', async () => {
    const content = `inflight-delete-${Date.now()}`;
    let messageId = '';
    await withDeliveryInFlight(
      async () => {
        const sent = await sendDmMessage(A, u1.token, dmId, { content });
        expect(sent.status).toBe(201);
        messageId = sent.id!;
      },
      () => dmMessageContents(B).includes(content),
      'the message on B (the held batch)',
      async () => { expect(await messageRequest('DELETE', messageId)).toBe(200); },
    );
    await waitForRelay(() => !dmMessageContents(B).includes(content), {
      ...relay,
      what: 'the message gone from B, deleted while its create was in flight',
    });
  });
});

describe('outbox: a relay whose first attempt fails (#367)', () => {
  // Its own user, so nothing the tests above left behind (or failed to
  // deliver) decides what B shows.
  let erinOnA: TestUser;
  let erinOnB: TestUser;

  beforeAll(async () => {
    ({ homeUser: erinOnA, remoteUser: erinOnB } = await createFederatedUser(A, B, 'erin'));
    withWritableDb(B, db => {
      db.prepare('UPDATE users SET home_instance = ? WHERE id = ?').run(A.origin, erinOnB.id);
    });
    sockets.push(await connectWs(A.origin, erinOnA.token));
    await waitForRelay(() => statusOn(B, erinOnB.id) === 'online', {
      ...relay,
      what: "erin's online status on B after she connects to A",
    });
  }, 60_000);

  it('is retried, and arrives inside the wait', async () => {
    await waitForOutboxDrained({ ...relay, what: 'A to have nothing queued or in flight for B' });
    tapB.failNextRelays(1);
    await setStatus(erinOnA, 'dnd');
    await waitForRelay(() => statusOn(B, erinOnB.id) === 'dnd', {
      ...relay,
      what: "erin's dnd on B, after its first delivery was answered 503",
    });
    // The failed attempt really happened: the tap saw erin's dnd twice.
    expect(dndRelaysFor(erinOnA.id)).toBe(2);
  });
});
