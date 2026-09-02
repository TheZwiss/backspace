import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FederationRelayEvent } from '@backspace/shared';
import {
  bootTransportPeered,
  createDm,
  readDb,
  withWritableDb,
  waitUntil,
  settleRelays,
  type PeeredHarness,
} from './helpers/federationE2E.js';
import { registerLocal, createFederatedUser, type TestUser } from './helpers/testUsers.js';
import { connectWs } from './helpers/wsListener.js';
import { startRelayTap, type RelayTap } from './helpers/relayTap.js';
import type { SpawnedInstance } from './helpers/twoInstanceHarness.js';

// Four real instances, real handshakes, worker-driven delivery. The 5s unit
// default is unusable here; see federation-identity-deletion.test.ts.
vi.setConfig({ testTimeout: 30_000 });

/**
 * ── e2e gate for `56a4ba03` — federated call relays are addressed to the
 *    instances that host a member ────────────────────────────────────────────────
 *
 * `sendFederatedCallStart` now builds a `dm_call_start` payload PER RECIPIENT:
 *   - a DM whose members are all local produces no relay at all (it used to go
 *     to every active peer);
 *   - only instances that home a DM member are contacted;
 *   - the room-token map is scoped to the members the recipient homes, so a peer
 *     never receives credentials minted for the caller, for a local member, or
 *     for a member homed on another instance.
 *
 * A LiveKit token is a bearer credential — whoever holds it can join the call
 * room under the identity it names — so "which tokens were in which payload" is
 * the security-relevant fact, and it exists only on the wire. A receiving
 * instance cannot report what it did NOT get. Each peer therefore sits behind a
 * `RelayTap`: a transparent recording reverse proxy that records every S2S
 * request and forwards it verbatim to the real instance, so peering, the signed
 * `/epoch` probe and delivery all behave normally while the conversation stays
 * readable. Nothing is mocked.
 *
 * LiveKit itself is never contacted: `generateFederatedCallToken` mints a JWT
 * locally with `livekit-server-sdk`'s `AccessToken`, so synthetic credentials
 * exercise the entire real path offline. No production module is stubbed.
 *
 * Topology: caller and one plain local member on A; one member homed on B; one
 * homed on C; and D, peered with A over the same real handshake but hosting
 * nobody.
 *
 * ── Non-vacuity ──────────────────────────────────────────────────────────────
 * The negatives ("the all-local call relayed nowhere", "D was contacted by
 * nothing", "B holds no token for dave") are all asserted against taps that, in
 * the same run, DID record a `dm_call_start` for B and for C. `beforeAll`
 * additionally snapshots every tap right after the all-local call and again
 * after the federated one, so the two are distinguished in time rather than
 * being one undifferentiated "nothing happened". Token assertions are exact SET
 * EQUALITIES, not absence checks — a payload with an empty or missing token map
 * fails them just as loudly as one with an extra token.
 */

let h: PeeredHarness;
let A: SpawnedInstance;
let B: SpawnedInstance;
let C: SpawnedInstance;
let D: SpawnedInstance;
let tapB: RelayTap;
let tapC: RelayTap;
let tapD: RelayTap;

let caller: TestUser;
let localMember: TestUser;
let carolOnA: TestUser;
let daveOnA: TestUser;

/** dm_call_start events each tap had seen right after the ALL-LOCAL call. */
let afterLocalCall: { b: number; c: number; d: number };
/** All relay events each tap saw over the whole run. */
let finalB: FederationRelayEvent[] = [];
let finalC: FederationRelayEvent[] = [];
let finalD: FederationRelayEvent[] = [];

const callStarts = (tap: RelayTap): FederationRelayEvent[] =>
  tap.relayEvents().filter(e => e.eventType === 'dm_call_start');

beforeAll(async () => {
  // The taps must exist before the rig boots — their origins are what the
  // handshake dials — but each tap's upstream is only knowable once its
  // instance has bound a port. So: create the taps, boot the rig telling it to
  // dial the taps, and wire each tap to its instance in `beforePeering`, which
  // runs after boot and before the first handshake.
  tapB = await startRelayTap();
  tapC = await startRelayTap();
  tapD = await startRelayTap();
  const taps = [tapB, tapC, tapD];

  h = await bootTransportPeered(3, {
    dialOrigins: taps.map(t => t.origin),
    beforePeering: (_home, remotes) => {
      remotes.forEach((remote, i) => taps[i]!.setTarget(remote.origin));
    },
  });
  A = h.home;
  B = h.remotes[0]!;
  C = h.remotes[1]!;
  D = h.remotes[2]!;

  caller = await registerLocal(A, 'caller');
  localMember = await registerLocal(A, 'localmate');
  carolOnA = (await createFederatedUser(B, A, 'carol')).remoteUser;
  daveOnA = (await createFederatedUser(C, A, 'dave')).remoteUser;

  withWritableDb(A, db => {
    // Point each replicated member at the origin A knows its home instance by,
    // so identity, routing and the peer row agree — the loopback stand-in for
    // production's single `https://DOMAIN`.
    db.prepare('UPDATE users SET home_instance = ? WHERE id = ?').run(tapB.origin, carolOnA.id);
    db.prepare('UPDATE users SET home_instance = ? WHERE id = ?').run(tapC.origin, daveOnA.id);
    // The real group-DM endpoint gates on friendship. Seeding the social graph
    // is setup; everything under test happens downstream of it.
    const ins = db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?,?,?)');
    for (const other of [localMember.id, carolOnA.id, daveOnA.id]) {
      ins.run(caller.id, other, Date.now());
      ins.run(other, caller.id, Date.now());
    }
  });

  const ws = await connectWs(A.origin, caller.token);
  try {
    // ── All-local call first, so its (non-)effect is observable on its own ──
    const localDm = await createDm(A, caller.token, localMember.id);
    ws.send({ type: 'dm_call_start', dmChannelId: localDm });
    await settleRelays();
    afterLocalCall = {
      b: callStarts(tapB).length,
      c: callStarts(tapC).length,
      d: callStarts(tapD).length,
    };

    // ── Then the federated group call ──
    const gRes = await fetch(`${A.origin}/api/dm/group`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({
        users: [{ id: localMember.id }, { id: carolOnA.id }, { id: daveOnA.id }],
      }),
    });
    if (gRes.status !== 201) throw new Error(`group DM create failed: ${gRes.status} ${await gRes.text()}`);
    const group = await gRes.json() as { id: string };

    ws.send({ type: 'dm_call_start', dmChannelId: group.id });
    const relayed = await waitUntil(() => callStarts(tapB).length > 0 && callStarts(tapC).length > 0);
    if (!relayed) throw new Error('federated dm_call_start never reached B and C');
    // Give a stray broadcast several more outbox ticks to show up at D.
    await settleRelays();
  } finally {
    ws.close();
  }

  finalB = tapB.relayEvents();
  finalC = tapC.relayEvents();
  finalD = tapD.relayEvents();
}, 180_000);

afterAll(async () => {
  for (const t of [tapB, tapC, tapD]) {
    if (t) await t.close();
  }
  if (h) await h.cleanup();
}, 30_000);

describe('federation e2e — federated call relays are addressed per hosting instance (56a4ba03)', () => {
  it('setup control: A is really peered with all three instances through their taps', () => {
    const peers = readDb(A, db =>
      db.prepare('SELECT origin, status FROM federation_peers ORDER BY origin').all() as {
        origin: string; status: string;
      }[],
    );
    expect(peers).toHaveLength(3);
    expect(peers.every(p => p.status === 'active')).toBe(true);
    expect(peers.map(p => p.origin).sort()).toEqual([tapB.origin, tapC.origin, tapD.origin].sort());
    // And the taps really are in the path — each saw the handshake traffic.
    for (const tap of [tapB, tapC, tapD]) {
      expect(tap.requests.some(r => r.path.startsWith('/api/federation/peer/accept'))).toBe(true);
    }
  });

  it('a call in an all-local DM relays to nobody, while the federated call reaches both hosting instances', () => {
    // Snapshot taken right after the all-local call, before the group existed.
    expect(afterLocalCall).toEqual({ b: 0, c: 0, d: 0 });

    // POSITIVE CONTROL — the same machinery, later in the same run, does relay.
    // Without these two lines the assertion above would be satisfied by a rig
    // that simply never relays anything.
    expect(finalB.filter(e => e.eventType === 'dm_call_start')).toHaveLength(1);
    expect(finalC.filter(e => e.eventType === 'dm_call_start')).toHaveLength(1);
  });

  it('a peered instance hosting no member receives no conversation traffic at all', () => {
    // D completed the same real handshake as B and C and is an active peer, so
    // it was reachable and eligible — it simply hosts nobody.
    expect(finalD.filter(e => e.eventType === 'dm_call_start')).toHaveLength(0);

    // Not one DM-scoped event of ANY type: no call, no member_add, no message.
    // Presence and profile relays are broadcast by design and stay exempt, so
    // they are excluded here rather than being asserted away.
    const conversationEvents = finalD.filter(e => e.contextType !== 'profile');
    expect(conversationEvents).toEqual([]);

    // POSITIVE CONTROL for this assertion: D's tap is live and in the path — it
    // recorded real S2S traffic, and the setup control has already established D
    // as an ACTIVE peer. "D saw no conversation traffic" is therefore about
    // addressing, not about a dead tap or a peer that was never reachable.
    expect(tapD.requests.filter(r => r.path.startsWith('/api/federation/')).length).toBeGreaterThan(0);

    // And B, which does host a member, saw DM-scoped traffic over the same rig.
    expect(finalB.some(e => e.contextType !== 'profile')).toBe(true);
  });

  it('each peer receives room tokens ONLY for the members it homes', () => {
    const bCall = finalB.find(e => e.eventType === 'dm_call_start');
    const cCall = finalC.find(e => e.eventType === 'dm_call_start');
    expect(bCall).toBeDefined();
    expect(cCall).toBeDefined();

    const carolHomeId = carolOnA.homeUserId!;
    const daveHomeId = daveOnA.homeUserId!;

    // Exact set equality in both directions: an empty map, a missing map, a map
    // carrying the caller's credential, or one carrying the other peer's member
    // all fail here.
    expect(Object.keys(bCall!.call?.tokens ?? {})).toEqual([carolHomeId]);
    expect(Object.keys(cCall!.call?.tokens ?? {})).toEqual([daveHomeId]);

    // Spelled out, because these are the specific leaks the fix closed.
    expect(bCall!.call?.tokens).not.toHaveProperty(daveHomeId);
    expect(bCall!.call?.tokens).not.toHaveProperty(caller.id);
    expect(bCall!.call?.tokens).not.toHaveProperty(localMember.id);
    expect(cCall!.call?.tokens).not.toHaveProperty(carolHomeId);
    expect(cCall!.call?.tokens).not.toHaveProperty(caller.id);
    expect(cCall!.call?.tokens).not.toHaveProperty(localMember.id);
  });

  it('the tokens each peer receives are minted for that peer\'s own member', () => {
    const bCall = finalB.find(e => e.eventType === 'dm_call_start');
    const cCall = finalC.find(e => e.eventType === 'dm_call_start');

    // A LiveKit AccessToken is a signed JWT whose `sub` is the identity it was
    // minted for (`${homeUserId}:${displayName}`). Decoding the claim proves the
    // credential is genuinely scoped, not merely filed under the right key.
    const identityOf = (jwt: string): string => {
      const payload = jwt.split('.')[1];
      if (!payload) throw new Error('token is not a JWT');
      const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string };
      return json.sub ?? '';
    };

    const bToken = bCall!.call!.tokens![carolOnA.homeUserId!]!;
    const cToken = cCall!.call!.tokens![daveOnA.homeUserId!]!;
    expect(identityOf(bToken).startsWith(`${carolOnA.homeUserId}:`)).toBe(true);
    expect(identityOf(cToken).startsWith(`${daveOnA.homeUserId}:`)).toBe(true);
  });

  it('the non-secret participant roster stays complete on every recipient', () => {
    // Scoping applies to credentials, not to the roster — the recipient still
    // needs the full member list for identity matching. This also proves the
    // per-recipient payloads are not simply truncated copies.
    const bCall = finalB.find(e => e.eventType === 'dm_call_start');
    const cCall = finalC.find(e => e.eventType === 'dm_call_start');

    for (const call of [bCall, cCall]) {
      const ids = (call!.call?.participants ?? []).map(p => p.homeUserId).sort();
      expect(ids).toEqual(
        [caller.id, localMember.id, carolOnA.homeUserId!, daveOnA.homeUserId!].sort(),
      );
    }
  });

  it('both recipients were addressed with the same call room, so this is one call fanned out', () => {
    const bCall = finalB.find(e => e.eventType === 'dm_call_start');
    const cCall = finalC.find(e => e.eventType === 'dm_call_start');
    expect(bCall!.federatedId).toBeTruthy();
    expect(bCall!.federatedId).toBe(cCall!.federatedId);
    // Per-recipient payloads, not one shared object reused for everyone.
    expect(bCall!.messageId).not.toBe(cCall!.messageId);
  });
});
