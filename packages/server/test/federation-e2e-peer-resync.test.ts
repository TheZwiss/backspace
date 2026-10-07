import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationSyncResponse } from '@backspace/shared';
import {
  bootIdentityPeered,
  bootTransportPeered,
  createDm,
  identityOrigin,
  peerSecretOn,
  readDb,
  sendDmMessage,
  waitForRelay,
  withWritableDb,
  type PeeredHarness,
  type RelayWait,
} from './helpers/federationE2E.js';
import { buildHeadersForOrigin } from './helpers/hmacSign.js';
import { createFederatedUser, registerLocal, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsCapture } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

vi.setConfig({ testTimeout: 45_000 });

/**
 * ── e2e gate for #255: an established peer is pulled again ───────────────────
 *
 * Before #255 an instance pulled a peer's mutation log only when the peering
 * became active, so anything it lost afterwards (a rejection, an expired
 * outbox row, a restore from backup) stayed lost. Now every active peer is
 * pulled periodically from a cursor in the peer's clock, and every relayed
 * event is safe to apply again.
 *
 * The periodic timer is not waited for: `POST /api/admin/test/federation/resync`
 * runs one pull now (test-gated like seed-peer).
 *
 * TRANSPORT profile: both instances deliver live through their outbox workers,
 * and each can sign a `/sync` request to the other.
 */

interface ResyncAnswer {
  result: {
    contexts: Record<string, string>;
    applied: number;
    duplicates: number;
    deferred: number;
    dropped: number;
  } | null;
  retried: number;
}

async function resync(puller: SpawnedInstance, peerOrigin: string, contexts?: string[]): Promise<ResyncAnswer> {
  const res = await fetch(`${puller.origin}/api/admin/test/federation/resync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerOrigin, ...(contexts ? { contexts } : {}) }),
  });
  expect(res.status).toBe(200);
  return await res.json() as ResyncAnswer;
}

function countContent(inst: SpawnedInstance, content: string): number {
  return readDb(inst, db =>
    (db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE content = ?').get(content) as { n: number }).n,
  );
}

function closedFlag(inst: SpawnedInstance, userId: string): number | null {
  return readDb(inst, db =>
    (db.prepare('SELECT closed FROM dm_members WHERE user_id = ?').get(userId) as { closed: number | null } | undefined)?.closed ?? null,
  );
}

describe('pull sync of an established peer (#255)', () => {
  let h: PeeredHarness;
  let A: SpawnedInstance;
  let B: SpawnedInstance;
  /** Native on A. */
  let u1: TestUser;
  /** Native on B, with a federated account on A: u1's DM partner. */
  let carolOnB: TestUser;
  let carolOnA: TestUser;
  let dmId: string;
  let relayAtoB: Omit<RelayWait, 'what'>;
  let relayBtoA: Omit<RelayWait, 'what'>;
  const sockets: WsCapture[] = [];

  beforeAll(async () => {
    h = await bootTransportPeered(1);
    A = h.home;
    B = h.remotes[0]!;
    relayAtoB = { sender: A, receiver: B };
    relayBtoA = { sender: B, receiver: A };

    u1 = await registerLocal(A, 'u1');
    ({ homeUser: carolOnB, remoteUser: carolOnA } = await createFederatedUser(B, A, 'carol'));
    withWritableDb(A, db => {
      // A knows B by B's own origin; carol's row on A names it.
      db.prepare('UPDATE users SET home_instance = ? WHERE id = ?').run(B.origin, carolOnA.id);
    });
    dmId = await createDm(A, u1.token, carolOnA.id);

    const first = `resync-first-${Date.now()}`;
    expect((await sendDmMessage(A, u1.token, dmId, { content: first })).status).toBe(201);
    await waitForRelay(() => countContent(B, first) === 1, { ...relayAtoB, what: 'the first message on B' });
    withWritableDb(B, db => {
      // B created u1's row from the relay with the bare host; point it at A's
      // origin, as a production row names https://DOMAIN, so B relays to A.
      db.prepare('UPDATE users SET home_instance = ? WHERE home_user_id = ?').run(A.origin, u1.id);
    });
  }, 120_000);

  afterAll(async () => {
    for (const ws of sockets) ws.close();
    if (h) await h.cleanup();
  }, 30_000);

  it('brings back a message B lost after it was delivered, once, and raises nothing on B', async () => {
    // Establish B's cursor for A, so what follows is past it.
    expect((await resync(B, A.origin)).result?.contexts.dm).toBe('ok');

    const lost = `resync-lost-${Date.now()}`;
    expect((await sendDmMessage(A, u1.token, dmId, { content: lost })).status).toBe(201);
    await waitForRelay(() => countContent(B, lost) === 1, { ...relayAtoB, what: 'the message on B before it is lost' });

    // B loses it, as a restore from a backup taken before it would.
    withWritableDb(B, db => { db.prepare('DELETE FROM dm_messages WHERE content = ?').run(lost); });
    expect(countContent(B, lost)).toBe(0);

    const carolWs = await connectWs(B.origin, carolOnB.token);
    sockets.push(carolWs);

    const pulled = await resync(B, A.origin);
    expect(pulled.result?.contexts.dm).toBe('ok');
    expect(countContent(B, lost)).toBe(1);

    // Catch-up, not news: no dm_message_created for it on B.
    expect(carolWs.events.filter(e => e.type === 'dm_message_created')).toEqual([]);

    // Pulling again changes nothing.
    await resync(B, A.origin);
    expect(countContent(B, lost)).toBe(1);
  });

  it('a replayed dm_close does not close the conversation a later message reopened', async () => {
    const onB = readDb(B, db =>
      (db.prepare('SELECT dm_channel_id AS id FROM dm_members WHERE user_id = ?').get(carolOnB.id) as { id: string }).id,
    );
    const res = await fetch(`${B.origin}/api/dm/${onB}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${carolOnB.token}` },
    });
    expect(res.status).toBe(200);
    await waitForRelay(() => closedFlag(A, carolOnA.id) === 1, { ...relayBtoA, what: "carol's close on A" });

    // u1 writes again: the conversation reopens for carol on both sides.
    const after = `resync-after-close-${Date.now()}`;
    expect((await sendDmMessage(A, u1.token, dmId, { content: after })).status).toBe(201);
    expect(closedFlag(A, carolOnA.id)).toBe(0);
    await waitForRelay(() => countContent(B, after) === 1, { ...relayAtoB, what: 'the reopening message on B' });

    // A pulls B's log, which still holds carol's dm_close.
    const pulled = await resync(A, B.origin);
    expect(pulled.result?.contexts.dm).toBe('ok');
    expect(closedFlag(A, carolOnA.id)).toBe(0);
  });
});

describe('identity profile with the reverse handshake (#333)', () => {
  let h: PeeredHarness;

  beforeAll(async () => {
    h = await bootIdentityPeered(1, { reverse: true });
  }, 90_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  }, 30_000);

  it('the home answers a /sync request the remote signs as its identity origin', async () => {
    const remote = h.remotes[0]!;
    const signer = identityOrigin(remote);
    const secret = peerSecretOn(h.home, signer);
    const body = JSON.stringify({ sinceTimestamp: 0, limit: 10 });
    const res = await fetch(`${h.home.origin}/api/federation/sync`, {
      method: 'POST',
      headers: buildHeadersForOrigin(body, secret, signer),
      body,
    });
    expect(res.status).toBe(200);
    const data = await res.json() as FederationSyncResponse;
    expect(data.events).toEqual([]);
  });
});
