import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { isFederationRelayEnabled } from './federationOutbox.js';
import { generateSnowflake } from './snowflake.js';
import { healResetIncarnation } from './federationReset.js';
import { syncPeerMutationLog } from './federationSync.js';
import type { PeerExitCause } from './federationPeerState.js';

export type PeerActivationReason =
  | 'initiate_accepted'
  | 'accept_rejected_override'
  | 'accept_awaiting_approval'
  | 'accept_awaiting_approval_fallback'
  | 'accept_pending'
  | 'accept_new'
  | 'approval_handshake'
  | 'health_check_recovery'
  | 'ensure_peered'
  | 'stale_peering_verified'
  | 'startup_bootstrap';

// Dedup: concurrent activations for the same peerId share one promise.
const inFlightActivation = new Map<string, Promise<void>>();

/**
 * Called whenever federation_peers.status transitions to 'active' for any reason.
 * Two independent invariants — both run unconditionally:
 *   1. Reset outbox backoff (nextRetryAt = now, attempts = 0) for this peer.
 *   2. Pull-sync the peer's mutation log (`syncPeerMutationLog`, utils/federationSync.ts)
 *      from this instance's cursors for it, every context.
 *
 * Called by the peer state machine (utils/federationPeerState.ts) on every
 * transition into `active`, with the transition's activation reason, and by
 * startupBootstrapSync. No other code calls it.
 *
 * Deduplicated by peerId — concurrent calls share one promise.
 */
export async function onPeerActivated(
  peerId: string,
  reason: PeerActivationReason,
): Promise<void> {
  const existing = inFlightActivation.get(peerId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      resetOutboxBackoff(peerId);

      // Instance-epoch self-heal. If this origin has an unresolved reset journal
      // AND this is a genuine re-handshake activation (reason gate lives inside
      // healResetIncarnation), heal the dead incarnation's stale stubs BEFORE the
      // mutation-log re-sync below — so re-sync repopulates onto a clean slate
      // (design §6.1). By this point the activation path has already (re)written
      // peer_instance_id to the freshly-exchanged epoch. Runs OUTSIDE any
      // transaction: tombstoneUser opens its own, and better-sqlite3 throws on a
      // nested BEGIN. No-op on non-handshake reasons (health_check_recovery /
      // startup_bootstrap) and when no reset is journaled.
      const resetPeerRow = getDb()
        .select({ origin: schema.federationPeers.origin, epoch: schema.federationPeers.peerInstanceId })
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, peerId))
        .get();
      if (resetPeerRow?.epoch) {
        healResetIncarnation(resetPeerRow.origin, resetPeerRow.epoch, reason);
      }

      await syncPeerMutationLog(peerId, reason);
      await fanoutOutboundSubscribers(peerId);

      // Look up the peer's origin once for the post-sync invariants.
      const peerRow = getDb()
        .select({ origin: schema.federationPeers.origin })
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, peerId))
        .get();
      if (peerRow?.origin) {
        // The record pass asks the peer about each of its users' rows here,
        // one lookup at a time, so it runs in the background: the presence
        // snapshot below must not wait for it.
        const origin = peerRow.origin;
        const { backfillStubUsernamesForPeer } = await import('./federationStubBackfill.js');
        void backfillStubUsernamesForPeer(origin).catch((e: unknown) => {
          console.warn('[onPeerActivated] backfillStubUsernamesForPeer(%s) failed', origin, e);
        });

        // Re-emit a fresh presence snapshot to the activating peer so its stubs
        // of our online natives reflect current reality. Necessary because
        // presence is outbox-only (no mutation-log replay), and any prior
        // markPeerStubsOffline ran on our side too.
        const { snapshotPresenceForPeer } = await import('./federationPresence.js');
        try { await snapshotPresenceForPeer(peerRow.origin); } catch (e) {
          console.warn('[onPeerActivated] snapshotPresenceForPeer(%s) failed', peerRow.origin, e);
        }
      }

      const { connectionManager } = await import('../ws/handler.js');
      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
    } catch (err) {
      console.error('[federation] onPeerActivated(%s, %s) failed:', peerId, reason, err);
    }
  })();

  inFlightActivation.set(peerId, promise);
  try {
    await promise;
  } finally {
    inFlightActivation.delete(peerId);
  }
}

/**
 * Reset all outbox backoff state for a peer (nextRetryAt = now, attempts = 0).
 * Unconditional across all entries of the peer — see spec §Invariant 1.
 */
export function resetOutboxBackoff(peerId: string): void {
  const db = getDb();
  const now = Date.now();
  const result = db
    .update(schema.federationOutbox)
    .set({ nextRetryAt: now, attempts: 0 })
    .where(eq(schema.federationOutbox.peerId, peerId))
    .run();
  if (result.changes > 0) {
    console.log(`[federation] Reset backoff on ${result.changes} outbox entries for peer ${peerId}`);
  }
}

/**
 * Fan out approved-notifications to all subscribers of any outbound
 * peer_approval_requests row matching this activated peer's origin, then
 * cascade-delete the parent row (which clears subscriber rows via the
 * schema's onDelete: 'cascade').
 *
 * Single-source-of-truth cleanup hook for outbound subscribers. Runs from
 * inside onPeerActivated so EVERY activation path triggers it, regardless
 * of how the peer became active (queue approval, /peer/initiate,
 * autoAccept=1 remote, mutual-approval token verification).
 *
 * Critical correctness invariant: cleanup hangs off status→active, NOT off
 * the local admin's approve action. When the remote also gates, our peer
 * row goes to awaiting_approval first; subscribers must remain queued
 * until the remote also approves and the peer fully activates.
 *
 * No-op when no outbound queue row exists for the origin (the common case
 * for non-gated peerings).
 *
 * Does NOT broadcast federation_peers_changed itself — onPeerActivated
 * does that after this returns, so the queue-change signal is unified
 * with the peer-state-change signal admins already receive.
 */
async function fanoutOutboundSubscribers(peerId: string): Promise<void> {
  const db = getDb();
  const peer = db
    .select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.id, peerId))
    .get();
  if (!peer) return;

  const parent = db
    .select()
    .from(schema.peerApprovalRequests)
    .where(
      and(
        eq(schema.peerApprovalRequests.origin, peer.origin),
        eq(schema.peerApprovalRequests.direction, 'outbound'),
      ),
    )
    .get();
  if (!parent) return;

  const subscribers = db
    .select()
    .from(schema.peerApprovalSubscribers)
    .where(eq(schema.peerApprovalSubscribers.requestId, parent.id))
    .all();

  const now = Date.now();
  const { connectionManager } = await import('../ws/handler.js');

  for (const sub of subscribers) {
    db.insert(schema.peerApprovalNotifications)
      .values({
        id: generateSnowflake(),
        userId: sub.userId,
        kind: 'approved',
        peerOrigin: peer.origin,
        triggerReason: sub.triggerReason,
        triggerTarget: sub.triggerTarget,
        createdAt: now,
        readAt: null,
      })
      .run();

    connectionManager.sendToUser(sub.userId, {
      type: 'peering_notification_received' as const,
      kind: 'approved',
    });
    // The subscriber row is about to cascade-delete; tell the user's UI to
    // refetch its pending list so the now-stale row disappears.
    connectionManager.sendToUser(sub.userId, {
      type: 'peering_subscription_changed' as const,
    });
  }

  // Cascade-deletes subscriber rows via onDelete: 'cascade'.
  db.delete(schema.peerApprovalRequests)
    .where(eq(schema.peerApprovalRequests.id, parent.id))
    .run();

  if (subscribers.length > 0) {
    console.log(
      `[federation] fanoutOutboundSubscribers(${peerId}) approved ${subscribers.length} subscriber notification${subscribers.length === 1 ? '' : 's'} for ${peer.origin}`,
    );
  }
}

/**
 * Startup bootstrap — scan for freshly-peered rows (status='active', lastSyncedAt=0)
 * and run onPeerActivated for each. Replaces runInitialSyncForNewPeers.
 * Invoked from startFederationWorkers. Peers that have synced before are
 * pulled by the periodic pull instead (`startPeerSyncWorkers`, first run a
 * minute after boot), which is what covers a restart or a restore.
 */
export async function startupBootstrapSync(): Promise<void> {
  if (!isFederationRelayEnabled()) return;

  const db = getDb();
  const firstTimePeers = db.select().from(schema.federationPeers)
    .where(and(
      eq(schema.federationPeers.status, 'active'),
      eq(schema.federationPeers.lastSyncedAt, 0),
    )).all();

  for (const peer of firstTimePeers) {
    await onPeerActivated(peer.id, 'startup_bootstrap');
  }

  // One-shot stub-username backfill for ALL currently-active peers (including
  // those with lastSyncedAt > 0). Heals legacy snowflake-named stubs created
  // before resolveOrCreateReplicatedUser used the realname scheme. Idempotent;
  // skips stubs already migrated. Non-blocking — failures retry on next
  // onPeerActivated for that origin.
  const allActivePeers = db.select({ origin: schema.federationPeers.origin })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'active'))
    .all();
  const { backfillStubUsernamesForPeer } = await import('./federationStubBackfill.js');
  for (const peer of allActivePeers) {
    backfillStubUsernamesForPeer(peer.origin).catch((err) => {
      console.warn('[startup] stub-backfill %s failed', peer.origin, err);
    });
  }
}

// Why a peer left `active`: the cause of the transition (utils/federationPeerState.ts).
export type PeerDeactivationReason = PeerExitCause;

// Dedup: concurrent deactivations for the same peerId share one promise.
// SEPARATE from inFlightActivation — a flapping peer's activate-then-deactivate
// sequence must not collapse into one slot.
const inFlightDeactivation = new Map<string, Promise<void>>();

/**
 * Called whenever federation_peers.status transitions OUT OF 'active' for any reason.
 * Sweeps connectionManager.federatedCalls for entries whose federatedCallHost matches
 * the peer origin, emitting dm_call_undeliverable { phase: 'host_unreachable', terminal: true }
 * to stranded ringed users and clearing the entries.
 *
 * Called by the peer state machine (utils/federationPeerState.ts) on every
 * transition out of `active`, with the transition's cause. No other code calls it.
 *
 * Deduplicated by peerId — concurrent calls share one promise. Separate map from
 * onPeerActivated so flapping peers don't collapse transitions.
 */
export async function onPeerDeactivated(
  peerId: string,
  reason: PeerDeactivationReason,
): Promise<void> {
  const existing = inFlightDeactivation.get(peerId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const db = getDb();
      const peer = db.select({
        origin: schema.federationPeers.origin,
        status: schema.federationPeers.status,
        instanceName: schema.federationPeers.instanceName,
      })
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, peerId))
        .get();

      if (!peer) {
        // Peer row gone — nothing to sweep against.
        return;
      }

      const { connectionManager } = await import('../ws/handler.js');

      // Map status to user-facing reason.
      const isRejectedLike = peer.status === 'rejected' || peer.status === 'revoked';
      const mappedReason: 'peer_rejected' | 'peer_transient_failure' =
        isRejectedLike ? 'peer_rejected' : 'peer_transient_failure';

      const evicted = connectionManager.evictFederatedCallsForHost(peer.origin, {
        reason: mappedReason,
        peerLabel: peer.instanceName ?? undefined,
      });

      if (evicted > 0) {
        console.log(
          `[federation] onPeerDeactivated(${peerId}, ${reason}) evicted ${evicted} FederatedCallEntry object${evicted === 1 ? '' : 's'} for ${peer.origin}`,
        );
      }

      // Mark every stub whose home is this peer as offline locally, and
      // broadcast a presence_update WS event to friends/DM-mates/space-co-members
      // so connected users see them go offline immediately, instead of seeing
      // stale 'online' until the peer recovers.
      try {
        const { markPeerStubsOffline } = await import('./federationPresence.js');
        await markPeerStubsOffline(peer.origin);
      } catch (e) {
        console.warn('[onPeerDeactivated] markPeerStubsOffline(%s) failed', peer.origin, e);
      }

      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
    } catch (err) {
      console.error('[federation] onPeerDeactivated(%s, %s) failed:', peerId, reason, err);
    }
  })();

  inFlightDeactivation.set(peerId, promise);
  try {
    await promise;
  } finally {
    inFlightDeactivation.delete(peerId);
  }
}
