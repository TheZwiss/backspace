import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { isFederationRelayEnabled } from './federationOutbox.js';
import { buildFederationHeaders, getOurOrigin } from './federationAuth.js';
import { generateSnowflake } from './snowflake.js';
import type { FederationRelayEvent } from '@backspace/shared';

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
  | 'startup_bootstrap';

// Dedup: concurrent activations for the same peerId share one promise.
const inFlightActivation = new Map<string, Promise<void>>();

/**
 * Called whenever federation_peers.status transitions to 'active' for any reason.
 * Two independent invariants — both run unconditionally:
 *   1. Reset outbox backoff (nextRetryAt = now, attempts = 0) for this peer.
 *   2. Pull-sync mutation log from peer's /api/federation/sync since lastSyncedAt.
 *
 * Call sites (must remain exhaustive — grep `onPeerActivated(` to audit):
 *   - routes/federation.ts /peer/initiate activation
 *   - routes/federation.ts /peer/accept existing-rejected override
 *   - routes/federation.ts /peer/accept existing-awaiting_approval
 *   - routes/federation.ts /peer/accept existing-pending
 *   - routes/federation.ts /peer/accept new-peer
 *   - routes/federation.ts /approval-requests/:id/approve
 *   - utils/federationWorker.ts health check recovery
 *   - utils/federationPeering.ts ensurePeered/performHandshake
 *   - utils/federationWorker.ts startup bootstrap (via startupBootstrapSync)
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
      await syncPeerMutationLog(peerId, reason);
      await fanoutOutboundSubscribers(peerId);
      const { connectionManager } = await import('../ws/handler.js');
      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
    } catch (err) {
      console.error(`[federation] onPeerActivated(${peerId}, ${reason}) failed:`, err);
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
 * Pull-sync mutation log from the peer's /api/federation/sync endpoint.
 * Runs three contextType passes (dm, friend, profile), paginating each.
 * Updates peer.lastSyncedAt to Date.now() on success; leaves it untouched
 * on transient failure so the next activation retries.
 */
export async function syncPeerMutationLog(
  peerId: string,
  reason: PeerActivationReason,
): Promise<void> {
  if (!isFederationRelayEnabled()) return;

  const db = getDb();
  const peer = db.select().from(schema.federationPeers)
    .where(eq(schema.federationPeers.id, peerId)).get();
  if (!peer || peer.status !== 'active') return;

  const activePeer = peer;  // narrowed by the guard above

  const ourOrigin = getOurOrigin();
  const signingSecret = (activePeer.pendingHmacSecret && activePeer.secretRotationAt)
    ? activePeer.pendingHmacSecret
    : activePeer.hmacSecret;

  console.log(`[federation] Sync-pull from ${activePeer.origin} (reason=${reason}, since=${activePeer.lastSyncedAt ?? 0})`);

  let totalEvents = 0;
  let skippedEvents = 0;

  type SyncRequestBody = {
    sinceTimestamp: number;
    limit: number;
    contextType?: 'friend' | 'profile';
  };

  async function runPass(contextType?: 'friend' | 'profile'): Promise<boolean> {
    let since = activePeer.lastSyncedAt ?? 0;
    while (true) {
      const bodyObj: SyncRequestBody = { sinceTimestamp: since, limit: 100 };
      if (contextType) bodyObj.contextType = contextType;
      const body = JSON.stringify(bodyObj);
      const headers = buildFederationHeaders(body, signingSecret, ourOrigin);
      const resp = await fetch(`${activePeer.origin}/api/federation/sync`, {
        method: 'POST', headers, body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        console.warn(`[federation] Sync-pull ${contextType ?? 'dm'} pass HTTP ${resp.status} for ${activePeer.origin}`);
        return false;
      }
      const data = await resp.json() as { events: FederationRelayEvent[]; hasMore: boolean; checkpoint: number };
      if (data.events.length === 0) return true;
      const { processRelayEvents } = await import('../routes/federation.js');
      for (const event of data.events) {
        try {
          await processRelayEvents([event], activePeer.origin, activePeer.origin, db);
          totalEvents += 1;
        } catch (err) {
          skippedEvents += 1;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(
            `[federation] Skipping poison-pill event during sync-pull from ${activePeer.origin}: ` +
            `eventType=${event.eventType} messageId=${event.messageId} timestamp=${event.timestamp} ` +
            `error=${errMsg}`,
          );
        }
      }
      since = data.checkpoint;
      if (!data.hasMore) return true;
    }
  }

  try {
    if (!(await runPass())) return;
    if (!(await runPass('friend'))) return;
    if (!(await runPass('profile'))) return;

    db.update(schema.federationPeers)
      .set({ lastSyncedAt: Date.now() })
      .where(eq(schema.federationPeers.id, activePeer.id))
      .run();

    if (totalEvents > 0 || skippedEvents > 0) {
      const skipSuffix = skippedEvents > 0 ? ` (${skippedEvents} skipped due to errors)` : '';
      console.log(`[federation] Sync-pull from ${activePeer.origin} replayed ${totalEvents} events${skipSuffix}`);
    }
  } catch (err) {
    console.error(`[federation] Sync-pull from ${activePeer.origin} failed:`, err);
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
 * Invoked from startFederationWorkers.
 */
export async function startupBootstrapSync(): Promise<void> {
  if (!isFederationRelayEnabled()) return;

  const db = getDb();
  const peers = db.select().from(schema.federationPeers)
    .where(and(
      eq(schema.federationPeers.status, 'active'),
      eq(schema.federationPeers.lastSyncedAt, 0),
    )).all();

  for (const peer of peers) {
    await onPeerActivated(peer.id, 'startup_bootstrap');
  }
}

export type PeerDeactivationReason =
  | 'network_threshold'        // outbox worker hit PEER_UNREACHABLE_THRESHOLD
  | 'auth_threshold'           // outbox worker hit AUTH_FAILURE_THRESHOLD
  | 'remote_rejected'          // auto-peer handshake got 403 PEERING_REQUIRES_APPROVAL
  | 'admin_revoked';           // admin revoked peering from this side

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
 * Call sites (must remain exhaustive — grep `onPeerDeactivated(` to audit):
 *   - utils/federationWorker.ts handleOutboxDeliveryFailure when status flips to 'unreachable'
 *   - utils/federationWorker.ts auth-failure path when status flips to 'needs_attention'
 *   - utils/federationWorker.ts resolvePendingPeers case 'rejected'
 *   - routes/federation.ts admin revoke endpoint
 *   - routes/federation.ts admin reset endpoint (when it transitions to a non-active status)
 *   - utils/federationPeering.ts performHandshake 403 PEERING_REQUIRES_APPROVAL path
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

      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
    } catch (err) {
      console.error(`[federation] onPeerDeactivated(${peerId}, ${reason}) failed:`, err);
    }
  })();

  inFlightDeactivation.set(peerId, promise);
  try {
    await promise;
  } finally {
    inFlightDeactivation.delete(peerId);
  }
}
