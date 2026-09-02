import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootTransportPeered,
  createDm,
  sendDmMessage,
  dmMessageContents,
  readDb,
  waitUntil,
  settleRelays,
  withWritableDb,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, createFederatedUser, type TestUser } from './helpers/testUsers.js';
import { startRelayTap, type RelayTap } from './helpers/relayTap.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Real instances, real HTTP, worker-driven delivery. See
// federation-identity-deletion.test.ts for why the 5s unit default is unusable here.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate for `4a5b5416` — DM relay is scoped to participant instances ─────
 *
 * `getGroupDmTargetOrigins` now returns `[]` (a target list matching no peer)
 * rather than `undefined` (which `queueOutboxEvent` reads as "broadcast to every
 * peer") when a conversation is entirely local, and `queueOutboxEvent` refuses a
 * `dm` event that arrives with no target list at all. The REST message-delete
 * path, which previously supplied no target list, now shares
 * `queueDmMessageDeleteRelay`.
 *
 * Topology: A is peered with BOTH B and C over the real handshake. B hosts a DM
 * participant; C hosts nobody in any conversation here. C is the "peered but
 * uninvolved instance" the fix exists to keep out of other people's DMs.
 *
 * Each peer sits behind a `RelayTap` — a transparent recording reverse proxy
 * that records every S2S request and forwards it verbatim, so peering and
 * delivery behave normally while the traffic stays readable. The tap is what
 * makes the delete assertions honest: a leaked message followed by a leaked
 * delete leaves NO trace in the receiver's database, so a DB-only check would
 * report "C never got it" for a conversation C had in fact been handed and then
 * told to forget. On the wire both events are plainly visible.
 *
 * TRANSPORT profile (see helpers/federationE2E.ts) so outbound routing resolves
 * to a live peer row and the outbox worker really delivers.
 *
 * ── Non-vacuity ──────────────────────────────────────────────────────────────
 * Every negative is asserted against taps that, in the same run, DID record the
 * corresponding positive: the federated message and its delete both reach B's
 * tap, and the federated message is observed landing in and then disappearing
 * from B's database. A rig that had stopped relaying — dead worker, broken
 * peering, wrong DB — fails those controls instead of passing the negatives for
 * free. Negatives additionally get `RELAY_SETTLE_MS` (several outbox ticks) of
 * slack, so a merely-delayed relay cannot slip past.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let C: SpawnedInstance;
let tapB: RelayTap;
let tapC: RelayTap;

let u1: TestUser;
let u2: TestUser;
/** Replicated on A, homed on B — the only remote participant anywhere here. */
let carolOnA: TestUser;

let localDmId: string;
let federatedDmId: string;

/** Relay events a tap recorded that belong to a conversation, not to broadcast. */
const conversationEvents = (tap: RelayTap): FederationRelayEvent[] =>
  tap.relayEvents().filter(e => e.contextType !== 'profile');

const carriesContent = (events: FederationRelayEvent[], content: string): boolean =>
  events.some(e => e.message?.content === content);

const referencesMessage = (events: FederationRelayEvent[], eventType: string, id: string): boolean =>
  events.some(e => e.eventType === eventType && e.messageId === id);

beforeAll(async () => {
  // Taps must exist before the rig boots (their origins are what gets peered),
  // and are wired to their instances in `beforePeering`, once ports are known.
  tapB = await startRelayTap();
  tapC = await startRelayTap();
  const taps = [tapB, tapC];

  h = await bootTransportPeered(2, {
    dialOrigins: taps.map(t => t.origin),
    beforePeering: (_home, remotes) => {
      remotes.forEach((remote, i) => taps[i]!.setTarget(remote.origin));
    },
  });
  A = h.home;
  B = h.remotes[0]!;
  C = h.remotes[1]!;

  u1 = await registerLocal(A, 'u1');
  u2 = await registerLocal(A, 'u2');

  // carol is native on B and holds a federated account on A. Point her A-side
  // row at the origin A knows B by, so identity, routing and the peer row agree
  // — the loopback stand-in for production's single `https://DOMAIN`.
  carolOnA = (await createFederatedUser(B, A, 'carol')).remoteUser;
  withWritableDb(A, db => {
    db.prepare('UPDATE users SET home_instance = ? WHERE id = ?').run(tapB.origin, carolOnA.id);
  });

  localDmId = await createDm(A, u1.token, u2.id);
  federatedDmId = await createDm(A, u1.token, carolOnA.id);
}, 120_000);

afterAll(async () => {
  for (const t of [tapB, tapC]) {
    if (t) await t.close();
  }
  if (h) await h.cleanup();
}, 30_000);

/** Outbox rows currently queued for a given DM, joined to their target peer. */
function outboxFor(inst: SpawnedInstance, contextId: string): { origin: string; eventType: string }[] {
  return readDb(inst, db =>
    db
      .prepare(`
        SELECT p.origin AS origin, o.event_type AS eventType
        FROM federation_outbox o
        JOIN federation_peers p ON p.id = o.peer_id
        WHERE o.context_id = ?
      `)
      .all(contextId) as { origin: string; eventType: string }[],
  );
}

describe('federation e2e — DM relay is scoped to participant instances (4a5b5416)', () => {
  it('setup control: A really is peered with both instances, through live taps', () => {
    // Without this, "C never received the message" would be satisfied by C
    // simply not being a peer, and the suite would prove nothing.
    const peers = readDb(A, db =>
      db.prepare('SELECT origin, status FROM federation_peers ORDER BY origin').all() as {
        origin: string; status: string;
      }[],
    );
    expect(peers).toHaveLength(2);
    expect(peers.every(p => p.status === 'active')).toBe(true);
    expect(peers.map(p => p.origin).sort()).toEqual([tapB.origin, tapC.origin].sort());
    for (const tap of [tapB, tapC]) {
      expect(tap.requests.some(r => r.path.startsWith('/api/federation/peer/accept'))).toBe(true);
    }
  });

  it('an all-local DM relays nowhere, while a federated DM in the same rig reaches its one participant instance', async () => {
    const localContent = `scoping-local-only-${Date.now()}`;
    const federatedContent = `scoping-federated-${Date.now()}`;

    const localSend = await sendDmMessage(A, u1.token, localDmId, { content: localContent });
    expect(localSend.status).toBe(201);

    const fedSend = await sendDmMessage(A, u1.token, federatedDmId, { content: federatedContent });
    expect(fedSend.status).toBe(201);

    // POSITIVE CONTROL — the rig demonstrably relays, on the wire and into the
    // receiver's database. If these fail the negatives below mean nothing, and
    // the suite says so here first.
    expect(await waitUntil(() => carriesContent(conversationEvents(tapB), federatedContent))).toBe(true);
    expect(await waitUntil(() => dmMessageContents(B).includes(federatedContent))).toBe(true);

    // Give any straggling outbox tick several more chances before asserting a
    // negative, so "suppressed" is not confused with "slow".
    await settleRelays();

    // The all-local conversation was never put on the wire to anyone...
    expect(carriesContent(conversationEvents(tapB), localContent)).toBe(false);
    expect(carriesContent(conversationEvents(tapC), localContent)).toBe(false);
    // ...and so never reached either database.
    expect(dmMessageContents(B)).not.toContain(localContent);
    expect(dmMessageContents(C)).not.toContain(localContent);
    // The federated one reached ONLY the instance hosting a participant.
    expect(carriesContent(conversationEvents(tapC), federatedContent)).toBe(false);
    expect(dmMessageContents(C)).not.toContain(federatedContent);

    // Nothing was even queued for the local-only conversation: an empty target
    // list matched no peer, so no outbox row was ever created for it.
    expect(outboxFor(A, localDmId)).toEqual([]);
  });

  it('deleting a message in an all-local DM relays nowhere, while deleting a federated one reaches the participant instance', async () => {
    const localContent = `scoping-del-local-${Date.now()}`;
    const federatedContent = `scoping-del-federated-${Date.now()}`;

    const localSend = await sendDmMessage(A, u1.token, localDmId, { content: localContent });
    expect(localSend.status).toBe(201);
    expect(localSend.id).toBeTruthy();

    const fedSend = await sendDmMessage(A, u1.token, federatedDmId, { content: federatedContent });
    expect(fedSend.status).toBe(201);
    expect(fedSend.id).toBeTruthy();

    expect(await waitUntil(() => dmMessageContents(B).includes(federatedContent))).toBe(true);

    const del = async (messageId: string): Promise<number> => {
      const res = await fetch(`${A.origin}/api/dm/messages/${messageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${u1.token}` },
      });
      return res.status;
    };

    expect(await del(localSend.id!)).toBe(200);
    expect(await del(fedSend.id!)).toBe(200);

    // POSITIVE CONTROL for the delete path specifically: the REST delete used to
    // supply no target list at all. It must still reach the peer that holds a
    // copy — proving this rig observes delete relays, which is what makes the
    // local-delete negative meaningful.
    expect(
      await waitUntil(() => referencesMessage(conversationEvents(tapB), 'delete', fedSend.id!)),
    ).toBe(true);
    expect(await waitUntil(() => !dmMessageContents(B).includes(federatedContent))).toBe(true);

    await settleRelays();

    // The local-only message and its delete were never put on the wire. Asserted
    // on the WIRE, not in the receivers' databases: a leaked create followed by a
    // leaked delete leaves the database looking exactly like a message that was
    // never relayed, so a DB-only check here would pass for the wrong reason.
    for (const tap of [tapB, tapC]) {
      const events = conversationEvents(tap);
      expect(carriesContent(events, localContent)).toBe(false);
      expect(referencesMessage(events, 'delete', localSend.id!)).toBe(false);
    }
    expect(referencesMessage(conversationEvents(tapC), 'delete', fedSend.id!)).toBe(false);
    expect(outboxFor(A, localDmId)).toEqual([]);
  });

  it('across the whole run, the peered-but-uninvolved instance saw no conversation traffic at all', () => {
    // Whole-rig invariant: C hosts no participant in any conversation created
    // here, so no DM-scoped event of any type should ever have been addressed to
    // it. Presence and profile relays are broadcast by design and stay exempt.
    expect(conversationEvents(tapC)).toEqual([]);

    // POSITIVE CONTROLS. C's tap is alive and in the path: it recorded real S2S
    // traffic (the handshake and the signed epoch probe), and the setup control
    // has already established C as an ACTIVE peer — so C was reachable and
    // eligible, and simply hosts nobody. Meanwhile B, which does host a
    // participant, received conversation traffic over the identical rig.
    //
    // Deliberately NOT asserted: that C received some relay event. Broadcast
    // profile/presence relays depend on whether anyone happened to change
    // presence during the run, so requiring one would make this control flaky
    // without making it stronger.
    expect(tapC.requests.filter(r => r.path.startsWith('/api/federation/')).length).toBeGreaterThan(0);
    expect(conversationEvents(tapB).length).toBeGreaterThan(0);

    // And nothing was ever queued for C either.
    const everQueuedForC = readDb(A, db =>
      db
        .prepare(`
          SELECT COUNT(*) AS n
          FROM federation_outbox o
          JOIN federation_peers p ON p.id = o.peer_id
          WHERE p.origin = ? AND o.context_type = 'dm'
        `)
        .get(tapC.origin) as { n: number },
    );
    expect(everQueuedForC.n).toBe(0);
  });
});
