import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  bootIdentityPeered,
  identityOrigin,
  peerSecretOn,
  postSignedRelay,
  queuedRelayEvents,
  sendDmMessage,
  readDb,
  waitUntil,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, createFederatedUser, type TestUser } from './helpers/testUsers.js';
import { connectWs, type WsEvent } from './helpers/wsListener.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';
import type { DmChannel } from '@backspace/shared';

// Real instances over real HTTP; the 5s unit default is too tight.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── GET /api/dm carries the conversation key the client dedups on ──────────
 *
 * A client connected to two instances learns which conversation an unknown
 * DM channel id belongs to by re-reading that instance's DM list, and it
 * matches the entry to the copy it already shows by `federatedId`. The list
 * used to leave that field out (the ready payload always had it), so the
 * mirrored copy an instance created for the first message of a new DM became
 * a second sidebar row.
 *
 * Topology (IDENTITY profile, so B's inbound relay handling is fully real):
 *   alice — native on A, with a federated account on B
 *   bob   — native on B
 * A's real create event is read from A's outbox and posted, signed, to B.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let alice: TestUser;
let aliceOnB: TestUser;
let bob: TestUser;

beforeAll(async () => {
  h = await bootIdentityPeered(1);
  A = h.home;
  B = h.remotes[0]!;
  ({ homeUser: alice, remoteUser: aliceOnB } = await createFederatedUser(A, B, 'alice'));
  bob = await registerLocal(B, 'bob');
}, 90_000);

afterAll(async () => {
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e: the DM list names the conversation of a mirrored copy', () => {
  it('B lists its mirrored copy of the alice-bob DM with the federatedId A assigned, in the ready shape', async () => {
    const created = await fetch(`${A.origin}/api/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ homeUserId: bob.id, homeInstance: B.domain }),
    });
    expect([200, 201]).toContain(created.status);
    const dmOnA = await created.json() as DmChannel;
    expect(dmOnA.federatedId).toMatch(/^[0-9a-f]{32}$/);

    const aliceOnBWs = await connectWs(B.origin, aliceOnB.token);
    try {
      const sent = await sendDmMessage(A, alice.token, dmOnA.id, { content: 'first message' });
      expect(sent.status).toBe(201);
      const event = queuedRelayEvents(A, dmOnA.id, 'create').find(e => e.messageId === sent.id);
      expect(event).toBeDefined();
      const res = await postSignedRelay(B, identityOrigin(A), peerSecretOn(B, identityOrigin(A)), [event!]);
      expect(res.body?.accepted).toContain(sent.id);

      // B mirrored the conversation under the same key.
      const onB = readDb(B, db => db.prepare(
        `SELECT c.id AS id, c.federated_id AS fid FROM dm_messages m
           JOIN dm_channels c ON c.id = m.dm_channel_id WHERE m.content = ?`,
      ).get('first message') as { id: string; fid: string });
      expect(onB.fid).toBe(dmOnA.federatedId);

      // The client learns about B's copy from a message for an id it has never
      // seen: no dm_channel_created precedes it. That is the path that reads the list.
      expect(await waitUntil(() => aliceOnBWs.events.some((e: WsEvent) =>
        e.type === 'dm_message_created'
        && (e.message as { dmChannelId?: string }).dmChannelId === onB.id), 8_000)).toBe(true);
      expect(aliceOnBWs.events.some(e => e.type === 'dm_channel_created')).toBe(false);

      // CONTROL: the ready payload of a fresh socket carries the key.
      const fresh = await connectWs(B.origin, aliceOnB.token);
      let readyEntry: DmChannel | undefined;
      try {
        const ready = fresh.events.find(e => e.type === 'ready') as { dmChannels?: DmChannel[] } | undefined;
        readyEntry = ready?.dmChannels?.find(d => d.id === onB.id);
      } finally {
        fresh.close();
      }
      expect(readyEntry?.federatedId).toBe(dmOnA.federatedId);

      const listRes = await fetch(`${B.origin}/api/dm`, { headers: { Authorization: `Bearer ${aliceOnB.token}` } });
      expect(listRes.status).toBe(200);
      const list = await listRes.json() as DmChannel[];
      const listed = list.find(d => d.id === onB.id);
      expect(listed).toBeDefined();
      expect(listed!.federatedId).toBe(dmOnA.federatedId);
      // The list entry is the ready entry: same keys, same values.
      expect(Object.keys(listed!).sort()).toEqual(Object.keys(readyEntry!).sort());
      expect(listed).toEqual(readyEntry);
    } finally {
      aliceOnBWs.close();
    }
  });
});
