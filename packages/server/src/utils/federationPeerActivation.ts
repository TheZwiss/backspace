import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { isFederationRelayEnabled } from './federationOutbox.js';
import { buildFederationHeaders, getOurOrigin } from './federationAuth.js';
import type { FederationRelayEvent } from '@backspace/shared';

export type PeerActivationReason =
  | 'initiate_accepted'
  | 'accept_rejected_override'
  | 'accept_awaiting_approval'
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
  // Stub — implemented in Task 4.
  void peerId;
  void reason;
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
  // Stub — implemented in Task 3.
  void peerId;
  void reason;
}

/**
 * Startup bootstrap — scan for freshly-peered rows (status='active', lastSyncedAt=0)
 * and run onPeerActivated for each. Replaces runInitialSyncForNewPeers.
 * Invoked from startFederationWorkers.
 */
export async function startupBootstrapSync(): Promise<void> {
  // Stub — implemented in Task 5.
}
