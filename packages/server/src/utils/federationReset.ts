import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { extractDomain } from '../routes/federation.js';
import { connectionManager } from '../ws/handler.js';

/** Pure-stub sentinel: a user replicated purely over S2S (no local credentials). */
const REPLICATED_STUB_SENTINEL = '!federation-replicated';

/**
 * SQL predicate matching every local user whose home instance is `origin`.
 *
 * `users.home_instance` is stored canonically as a bare domain
 * (`resolveOrCreateReplicatedUser` writes `extractDomain(...)`), so we key on
 * the bare domain. We additionally match the `https://`/`http://`-prefixed
 * forms so any legacy full-URL straggler is still caught — mirroring the
 * defensive normalization used across the outbox/worker paths. A silent
 * zero-match here would no-op the entire heal, so the match is deliberately
 * permissive on format while exact on domain.
 */
export function homeInstanceMatch(origin: string) {
  const domain = extractDomain(origin);
  return sql`(${schema.users.homeInstance} = ${domain} OR ${schema.users.homeInstance} = ${'https://' + domain} OR ${schema.users.homeInstance} = ${'http://' + domain})`;
}

/**
 * Detection-only reset routing. Invoked when a peer behind a known origin is
 * observed to carry a DIFFERENT instance epoch than the trusted baseline
 * (`federation_peers.peer_instance_id`) — i.e. the instance was wiped and a new
 * incarnation stood up on the same domain.
 *
 * This routes the peer to `needs_attention` (reason `peer_reset_detected`),
 * snapshots the dead incarnation's users (`federation_heal_pending = 1`), and
 * journals the dead epoch durably in `federation_reset_events`. It then notifies
 * admins.
 *
 * It performs **NO rekey, NO tombstone, NO handle change, NO content deletion**.
 * The trusted baseline (`peer_instance_id`) and the `hmac_secret` are left
 * untouched — the observed (but not yet trusted) epoch is recorded separately in
 * `observed_peer_instance_id`. Trust re-establishment is admin-gated (§5) and
 * the actual data heal fires only after an authenticated re-peer (§6). Because
 * none of this grants capability or destroys content, it is safe to fire on an
 * unauthenticated detection signal: the worst a spoofed detection can do is flag
 * a peer for admin review.
 *
 * Idempotent: if an UNRESOLVED reset row already exists for the origin (the peer
 * reset again before an admin resolved the first), the original `dead_epoch` and
 * `detected_at` are preserved — that is the incarnation whose users are already
 * snapshotted — and only the summary counts are refreshed.
 *
 * @param peerId        `federation_peers.id` of the reset peer.
 * @param origin        The peer origin (bare domain or full URL).
 * @param deadEpoch     The peer's trusted baseline epoch at detection time.
 * @param observedEpoch The new epoch observed on the peer.
 */
export function markPeerReset(peerId: string, origin: string, deadEpoch: string, observedEpoch: string): void {
  const db = getDb();

  db.transaction((tx) => {
    // 1. Route the peer to needs_attention and record the observed (untrusted)
    //    epoch. peer_instance_id (trusted baseline) and hmac_secret are NOT
    //    touched — an unauthenticated observation never rekeys trust.
    tx.update(schema.federationPeers)
      .set({
        status: 'needs_attention',
        needsAttentionReason: 'peer_reset_detected',
        observedPeerInstanceId: observedEpoch,
      })
      .where(eq(schema.federationPeers.id, peerId))
      .run();

    // 2. Snapshot exactly the current (dead-incarnation) users for this origin.
    //    Any stub created AFTER this point (e.g. a friend-add reaching the new
    //    incarnation directly) is un-flagged and survives the heal.
    tx.update(schema.users)
      .set({ federationHealPending: 1 })
      .where(and(eq(schema.users.isDeleted, 0), homeInstanceMatch(origin)))
      .run();

    // 3. Compute summary counts for the admin surface, over the freshly-flagged
    //    set: pure replicated stubs vs. real federated accounts (local content).
    const stubCount = tx
      .select({ n: sql<number>`count(*)` })
      .from(schema.users)
      .where(and(
        eq(schema.users.federationHealPending, 1),
        eq(schema.users.passwordHash, REPLICATED_STUB_SENTINEL),
        homeInstanceMatch(origin),
      ))
      .get()?.n ?? 0;

    const orphanedAccountCount = tx
      .select({ n: sql<number>`count(*)` })
      .from(schema.users)
      .where(and(
        eq(schema.users.federationHealPending, 1),
        sql`${schema.users.passwordHash} != ${REPLICATED_STUB_SENTINEL}`,
        homeInstanceMatch(origin),
      ))
      .get()?.n ?? 0;

    // 4. Journal the dead incarnation durably. This row survives the peer-row
    //    deletion that Re-peer performs, preserving dead_epoch for the
    //    false-positive guard and the admin surface.
    const existing = tx
      .select()
      .from(schema.federationResetEvents)
      .where(eq(schema.federationResetEvents.origin, origin))
      .get();

    if (existing && existing.resolvedAt === null) {
      // Double-reset: keep the ORIGINAL dead_epoch + detected_at (the
      // incarnation already snapshotted), refresh counts only. Never overwrite
      // dead_epoch on an unresolved row.
      tx.update(schema.federationResetEvents)
        .set({ stubCount, orphanedAccountCount })
        .where(eq(schema.federationResetEvents.origin, origin))
        .run();
    } else {
      // First detection for this origin, or a prior reset that was already
      // resolved — start a fresh journal entry.
      tx.insert(schema.federationResetEvents)
        .values({
          origin,
          deadEpoch,
          newEpoch: null,
          detectedAt: Date.now(),
          resolvedAt: null,
          stubCount,
          orphanedAccountCount,
        })
        .onConflictDoUpdate({
          target: schema.federationResetEvents.origin,
          set: {
            deadEpoch,
            newEpoch: null,
            detectedAt: Date.now(),
            resolvedAt: null,
            stubCount,
            orphanedAccountCount,
          },
        })
        .run();
    }
  });

  connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
  connectionManager.sendToAdmins({ type: 'federation_peer_reset_detected' as const, origin });
}
