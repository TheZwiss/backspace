import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { extractDomain } from '../routes/federation.js';
import { connectionManager } from '../ws/handler.js';
import { tombstoneUser, collectDeletionBroadcastTargets } from './userDeletion.js';
import { sanitizeUser } from './sanitize.js';
import type { PeerActivationReason } from './federationPeerActivation.js';

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

/**
 * Activation reasons that involve a fresh, HMAC-authenticated handshake which
 * (re)writes `federation_peers.peer_instance_id`. ONLY these reasons carry a
 * freshly-exchanged epoch that can be trusted to confirm-or-refute a reset.
 *
 * The two EXCLUDED members of `PeerActivationReason` — `health_check_recovery`
 * (a reachability flip in `markPeerRecovered`) and `startup_bootstrap` (a boot
 * re-scan) — flip a peer to `active` WITHOUT any handshake, so the baseline they
 * observe is STALE (still equal to the journaled `dead_epoch`). Letting the heal
 * run on those paths would take the `deadEpoch === newEpoch` false-alarm branch
 * and silently resolve the reset journal + clear the snapshot flags WITHOUT ever
 * healing — permanently burying the bug. The reason gate below stops that: on a
 * non-handshake activation the journal is left fully intact for a later genuine
 * re-handshake to heal.
 *
 * Typed as `ReadonlySet<PeerActivationReason>` so a typo or a future
 * union-member rename is caught by tsc, not at runtime.
 */
const HANDSHAKE_ACTIVATION_REASONS: ReadonlySet<PeerActivationReason> = new Set([
  'initiate_accepted',
  'accept_new',
  'accept_pending',
  'accept_rejected_override',
  'accept_awaiting_approval',
  'accept_awaiting_approval_fallback',
  'approval_handshake',
  'ensure_peered',
]);

/**
 * The data self-heal, fired from `onPeerActivated` AFTER an authenticated
 * re-peer (design §6). It is the counterpart to `markPeerReset`'s detection:
 * detection snapshots + journals but never destroys; this heals once — and only
 * once — the epoch change has been proven through a genuine handshake.
 *
 * Two mandatory guards, in order:
 *
 * 1. **Reason gate.** Returns immediately unless `reason` is a genuine
 *    handshake activation (see `HANDSHAKE_ACTIVATION_REASONS`). Reachability /
 *    startup flips carry a stale baseline and must leave the journal untouched.
 *
 * 2. **Epoch comparison (false-positive guard).** For a gated-in reason, look up
 *    the UNRESOLVED `federation_reset_events` row for the origin. If none → no
 *    outstanding reset → return.
 *    - `journal.deadEpoch === newEpoch`: the re-peer confirmed the SAME
 *      incarnation (a spurious/spoofed detection, or an admin re-peer to the
 *      never-reset live peer). **No tombstone** — the user-level snapshot flags
 *      alone must never drive destruction; only a confirmed epoch change
 *      authorizes it. Clear all heal flags for the origin and resolve the
 *      journal.
 *    - `journal.deadEpoch !== newEpoch`: a GENUINE new incarnation. Soft-
 *      tombstone the flagged PURE STUBS only, then clear their flags and resolve
 *      the journal.
 *
 * Real federated accounts (`federation_heal_pending = 1` but NOT a stub) carry
 * non-re-syncable local content and are **never** auto-tombstoned; they stay
 * flagged + intact for the Phase 2 quarantine/admin surface (design §6.3).
 *
 * **Transaction hazard:** `tombstoneUser` opens its OWN `db.transaction`, and
 * better-sqlite3 throws on a nested `BEGIN`. `healResetIncarnation` therefore
 * runs its `select`/`update` calls UNWRAPPED (never inside a transaction) and
 * calls `tombstoneUser` per-stub outside any open transaction. The caller
 * (`onPeerActivated`) must likewise not invoke this from within a transaction.
 *
 * @param origin   The reset peer's origin (bare domain or full URL).
 * @param newEpoch The peer's freshly-handshaked epoch (`peer_instance_id`).
 * @param reason   The activation reason that triggered this call.
 */
export function healResetIncarnation(origin: string, newEpoch: string, reason: PeerActivationReason): void {
  // Guard 1 — reason gate: only a genuine re-handshake carries a trustworthy epoch.
  if (!HANDSHAKE_ACTIVATION_REASONS.has(reason)) return;

  const db = getDb();

  const journal = db
    .select()
    .from(schema.federationResetEvents)
    .where(and(
      eq(schema.federationResetEvents.origin, origin),
      isNull(schema.federationResetEvents.resolvedAt),
    ))
    .get();
  if (!journal) return; // no outstanding reset for this origin

  // Guard 2 — epoch comparison (the false-positive guard).
  if (journal.deadEpoch === newEpoch) {
    // FALSE ALARM: re-peer confirmed the SAME incarnation. The snapshot flags
    // alone must NEVER drive a tombstone — clear them and resolve, no deletion.
    db.update(schema.users)
      .set({ federationHealPending: 0 })
      .where(and(eq(schema.users.federationHealPending, 1), homeInstanceMatch(origin)))
      .run();
    db.update(schema.federationResetEvents)
      .set({ newEpoch, resolvedAt: Date.now() })
      .where(eq(schema.federationResetEvents.origin, origin))
      .run();
    return;
  }

  // GENUINE reset: soft-tombstone the flagged PURE STUBS only.
  const stubs = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(
      eq(schema.users.federationHealPending, 1),
      eq(schema.users.passwordHash, REPLICATED_STUB_SENTINEL),
      homeInstanceMatch(origin),
    ))
    .all();

  // MANDATORY: purgeContent:false — a soft tombstone. The default (true) would
  // irreversibly delete this box's reactions / space messages, violating the
  // §1 invariant that a remote's reset never destroys our non-re-syncable
  // content. Each call opens its own transaction, so this loop stays UNWRAPPED.
  for (const stub of stubs) {
    // Collect co-members BEFORE tombstoning — it deletes the DM/friend/space
    // rows this set is derived from, so reading them after would return empty
    // and the survivors' clients would never learn the stub became a
    // "Deleted User". Mirrors admin.ts / users.ts / federation.ts identity-delete.
    const targets = collectDeletionBroadcastTargets(stub.id).targetUserIds;
    tombstoneUser(stub.id, { purgeContent: false });
    // Re-read the now-tombstoned row and broadcast the sanitized (anonymized)
    // profile so every surviving co-member updates live — no reload required.
    const deletedRow = db.select().from(schema.users).where(eq(schema.users.id, stub.id)).get();
    if (deletedRow) {
      const event = { type: 'user_updated' as const, user: sanitizeUser(deletedRow) };
      for (const targetId of targets) connectionManager.sendToUser(targetId, event);
    }
  }

  // Clear the heal flag on exactly the stubs we healed, keyed by id.
  // `tombstoneUser` has already randomized their `password_hash`, so re-querying
  // by the stub sentinel would miss them — the id list is the reliable key.
  if (stubs.length > 0) {
    db.update(schema.users)
      .set({ federationHealPending: 0 })
      .where(inArray(schema.users.id, stubs.map((s) => s.id)))
      .run();
  }

  // Quarantine the flagged REAL accounts (freeze + free-handle / surface). §6.3b.
  const orphanedCount = quarantineOrphanedAccounts(origin);

  // Resolve the journal and refresh the orphaned-account count to the frozen set.
  db.update(schema.federationResetEvents)
    .set({ newEpoch, resolvedAt: Date.now(), orphanedAccountCount: orphanedCount })
    .where(eq(schema.federationResetEvents.origin, origin))
    .run();
}

/**
 * Post-heal quarantine of the dead incarnation's REAL federated accounts (design
 * §6.3b). Called from `healResetIncarnation`'s genuine-reset branch AFTER the stub
 * soft-tombstone loop. Real accounts carry non-re-syncable local content and are
 * NEVER auto-deleted — they are FROZEN and surfaced to the admin.
 *
 * For every flagged real account (`federation_heal_pending = 1`,
 * `passwordHash != REPLICATED_STUB_SENTINEL`, `isDeleted = 0`) for this origin:
 *  - Set `federation_home_orphaned = 1` (FREEZE). This is universal — it is what
 *    closes the post-re-peer hijack (the Task-2 epoch guard passes once the
 *    baseline is updated to the new epoch, so the freeze is the only remaining
 *    barrier). The direct-login freeze (auth.ts) enforces it.
 *  - If the account OWNS local spaces: do NOT rename it. Space ownership must be
 *    resolved by a human (admin Remove → transfer/delete first). Renaming an owner
 *    would orphan the ownerId reference into a `!orphaned:` handle, confusing to
 *    members. It stays frozen + surfaced.
 *  - Otherwise: rename `username → !orphaned:{uid}@{domain}` to FREE the handle so
 *    a returning same-name user re-registers into a clean fresh account instead of
 *    colliding (defends BOTH login uniqueness AND the registration tier-2
 *    stub-resolution upgrade path — see the plan's collision analysis).
 *  - Clear `federation_heal_pending` (processed).
 *
 * Content (space messages, memberships, reactions) is preserved in all cases.
 *
 * @returns the number of accounts quarantined (frozen) — used to refresh the
 *          journal's `orphaned_account_count`.
 */
export function quarantineOrphanedAccounts(origin: string): number {
  const db = getDb();
  const domain = extractDomain(origin);

  const accounts = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(
      eq(schema.users.federationHealPending, 1),
      eq(schema.users.isDeleted, 0),
      sql`${schema.users.passwordHash} != ${REPLICATED_STUB_SENTINEL}`,
      homeInstanceMatch(origin),
    ))
    .all();

  for (const acct of accounts) {
    const ownsSpace = db
      .select({ id: schema.spaces.id })
      .from(schema.spaces)
      .where(eq(schema.spaces.ownerId, acct.id))
      .get();

    const updates: Record<string, string | number> = {
      federationHomeOrphaned: 1,
      federationHealPending: 0,
    };
    if (!ownsSpace) {
      // Free the handle only for non-owners.
      updates.username = `!orphaned:${acct.id}@${domain}`;
    }
    db.update(schema.users).set(updates).where(eq(schema.users.id, acct.id)).run();
  }

  return accounts.length;
}
