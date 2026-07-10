import { getRawDb } from '../../db/index.js';
import { computeFederatedId } from '../../utils/federationOutbox.js';
import { and, or } from 'drizzle-orm';
import { getOurIdentityDomain } from './identity.js';

export interface DmReconcileResult {
  action: 'noop' | 'rekeyed' | 'merged';
  channelId: string;
  targetChannelId: string;
  affectedUserIds: string[];
}


/**
 * Reconcile a single 1-on-1 DM channel's deterministic federatedId against its
 * members' CURRENT home identities (reattach-dm-reconcile spec §3.1). A 1-on-1
 * federatedId is f(sorted home user ids); when a participant's home_user_id
 * changes (re-attach), the channel's stored id goes stale and new messages
 * compute a different id → a split conversation. This re-keys the channel in
 * place, or — when a channel already carries the correct id (idx_dm_federated is
 * UNIQUE, so two rows can't share it) — merges this channel INTO that one and
 * deletes it.
 *
 * Idempotent: a correctly-keyed channel is a noop. Group DMs (UUID federatedId
 * or member count != 2) are skipped. Must be called inside a transaction.
 */
export function reconcileDmChannelFederatedId(
  rawDb: ReturnType<typeof getRawDb>,
  channelId: string,
): DmReconcileResult {
  const noop: DmReconcileResult = { action: 'noop', channelId, targetChannelId: channelId, affectedUserIds: [] };

  const chan = rawDb.prepare(`SELECT id, federated_id FROM dm_channels WHERE id = ? AND deleted_at IS NULL`).get(channelId) as
    { id: string; federated_id: string | null } | undefined;
  if (!chan || !chan.federated_id) return noop;
  // Only 1-on-1 shape (32 hex). Group DMs use a random UUID.
  if (!/^[0-9a-f]{32}$/.test(chan.federated_id)) return noop;

  const members = rawDb.prepare(`
    SELECT u.id, u.home_user_id FROM dm_members m JOIN users u ON u.id = m.user_id
    WHERE m.dm_channel_id = ?
  `).all(channelId) as Array<{ id: string; home_user_id: string | null }>;
  if (members.length !== 2) return noop;

  const homeA = members[0]!.home_user_id || members[0]!.id;
  const homeB = members[1]!.home_user_id || members[1]!.id;
  const expected = computeFederatedId(homeA, homeB);
  if (expected === chan.federated_id) return noop;

  const target = rawDb.prepare(`SELECT id FROM dm_channels WHERE federated_id = ? AND deleted_at IS NULL AND id != ?`).get(expected, channelId) as
    { id: string } | undefined;

  if (!target) {
    rawDb.prepare(`UPDATE dm_channels SET federated_id = ? WHERE id = ?`).run(expected, channelId);
    return { action: 'rekeyed', channelId, targetChannelId: channelId, affectedUserIds: members.map(m => m.id) };
  }

  // Merge source (channelId) INTO target, then delete source.
  const targetId = target.id;
  const targetMemberIds = (rawDb.prepare(`SELECT user_id FROM dm_members WHERE dm_channel_id = ?`).all(targetId) as Array<{ user_id: string }>).map(r => r.user_id);
  const affected = Array.from(new Set([...members.map(m => m.id), ...targetMemberIds]));

  // Messages: globally-unique ids, straight move (attachments + dm_reactions
  // reference dm_message_id and follow automatically).
  rawDb.prepare(`UPDATE dm_messages SET dm_channel_id = ? WHERE dm_channel_id = ?`).run(targetId, channelId);
  // Members: drop source rows already present on target (composite PK), repoint the rest.
  rawDb.prepare(`DELETE FROM dm_members WHERE dm_channel_id = ? AND user_id IN (SELECT user_id FROM dm_members WHERE dm_channel_id = ?)`).run(channelId, targetId);
  rawDb.prepare(`UPDATE dm_members SET dm_channel_id = ? WHERE dm_channel_id = ?`).run(targetId, channelId);
  // read_states: keyed by channel_id; dedupe on (user_id, channel_id) then repoint.
  rawDb.prepare(`DELETE FROM read_states WHERE channel_id = ? AND user_id IN (SELECT user_id FROM read_states WHERE channel_id = ?)`).run(channelId, targetId);
  rawDb.prepare(`UPDATE read_states SET channel_id = ? WHERE channel_id = ?`).run(targetId, channelId);
  // Remove the now-empty source channel.
  rawDb.prepare(`DELETE FROM dm_channels WHERE id = ?`).run(channelId);

  return { action: 'merged', channelId, targetChannelId: targetId, affectedUserIds: affected };
}


/**
 * Startup sweep: reconcile any 1-on-1 DM channel whose stored federatedId has
 * drifted from its members' current home identities (reattach-dm-reconcile
 * spec §3.3). Heals accounts re-attached before inline reconciliation shipped
 * (e.g. the live split-conversation duplicate). Idempotent; a noop on a clean DB.
 */
export function reconcileDriftedDmFederatedIds(): void {
  const rawDb = getRawDb();
  const candidates = rawDb.prepare(`
    SELECT c.id FROM dm_channels c
    WHERE c.deleted_at IS NULL
      AND c.federated_id IS NOT NULL
      AND (SELECT count(*) FROM dm_members m WHERE m.dm_channel_id = c.id) = 2
  `).all() as Array<{ id: string }>;
  if (candidates.length === 0) return;

  let rekeyed = 0;
  let merged = 0;
  rawDb.transaction(() => {
    for (const c of candidates) {
      // A prior merge in this loop may have deleted this id — reconcile returns
      // noop for a missing/mutated channel, so this is safe.
      const r = reconcileDmChannelFederatedId(rawDb, c.id);
      if (r.action === 'rekeyed') rekeyed++;
      else if (r.action === 'merged') merged++;
    }
  })();

  if (rekeyed > 0 || merged > 0) {
    console.log(`[federation] DM federatedId reconciliation: rekeyed ${rekeyed}, merged ${merged}`);
  }
}


/**
 * Remove dead-incarnation artifacts produced by pre-fix initial syncs
 * (dead-incarnation spec §3.4): DM channels with no native member, and
 * replicated stubs homed at this instance's own domain. Idempotent —
 * a no-op on a clean database. Synchronous (better-sqlite3), runs once
 * at startup from startFederationWorkers.
 *
 * Child rows are deleted explicitly: FK cascade enforcement cannot be
 * assumed ON, and dm_messages.user_id has no cascade anyway.
 */
export function sweepDeadIncarnationArtifacts(): void {
  const ourDomain = getOurIdentityDomain();
  if (!ourDomain) return;
  const rawDb = getRawDb();
  const normHome = `lower(replace(replace(coalesce(home_instance, ''), 'https://', ''), 'http://', ''))`;

  // ── 1. DM channels with no native member. A legitimate channel always
  //       involves a native user; native-less channels are sync junk. ──
  const junkChannelIds = (rawDb.prepare(`
    SELECT c.id FROM dm_channels c
    WHERE NOT EXISTS (
      SELECT 1 FROM dm_members m JOIN users u ON u.id = m.user_id
      WHERE m.dm_channel_id = c.id AND u.home_instance IS NULL
    )
  `).all() as Array<{ id: string }>).map(r => r.id);

  if (junkChannelIds.length > 0) {
    const ph = junkChannelIds.map(() => '?').join(',');
    rawDb.transaction(() => {
      rawDb.prepare(`DELETE FROM dm_reactions WHERE dm_message_id IN (SELECT id FROM dm_messages WHERE dm_channel_id IN (${ph}))`).run(...junkChannelIds);
      rawDb.prepare(`DELETE FROM attachments WHERE dm_message_id IN (SELECT id FROM dm_messages WHERE dm_channel_id IN (${ph}))`).run(...junkChannelIds);
      rawDb.prepare(`DELETE FROM dm_messages WHERE dm_channel_id IN (${ph})`).run(...junkChannelIds);
      rawDb.prepare(`DELETE FROM dm_members WHERE dm_channel_id IN (${ph})`).run(...junkChannelIds);
      rawDb.prepare(`DELETE FROM read_states WHERE channel_id IN (${ph})`).run(...junkChannelIds);
      rawDb.prepare(`DELETE FROM dm_channels WHERE id IN (${ph})`).run(...junkChannelIds);
    })();
  }

  // ── 2. Self-homed replicated stubs. Junk social rows referencing them go
  //       first; then stubs with no remaining non-cascading references. ──
  const stubSelect = `SELECT id FROM users WHERE password_hash = '!federation-replicated' AND ${normHome} = ?`;
  const allStubIds = (rawDb.prepare(stubSelect).all(ourDomain) as Array<{ id: string }>).map(r => r.id);

  let deletedStubs = 0;
  if (allStubIds.length > 0) {
    rawDb.transaction(() => {
      rawDb.prepare(`DELETE FROM friends WHERE user_id IN (${stubSelect}) OR friend_id IN (${stubSelect})`).run(ourDomain, ourDomain);
      rawDb.prepare(`DELETE FROM friend_requests WHERE from_id IN (${stubSelect}) OR to_id IN (${stubSelect})`).run(ourDomain, ourDomain);

      // Deletable = no rows left in any table whose FK to users.id does NOT
      // cascade, and no surviving dm/space membership or authored message.
      const deletable = (rawDb.prepare(`
        ${stubSelect}
          AND NOT EXISTS (SELECT 1 FROM dm_messages WHERE user_id = users.id)
          AND NOT EXISTS (SELECT 1 FROM messages WHERE user_id = users.id)
          AND NOT EXISTS (SELECT 1 FROM dm_members WHERE user_id = users.id)
          AND NOT EXISTS (SELECT 1 FROM space_members WHERE user_id = users.id)
          AND NOT EXISTS (SELECT 1 FROM spaces WHERE owner_id = users.id)
          AND NOT EXISTS (SELECT 1 FROM bans WHERE banned_by = users.id)
          AND NOT EXISTS (SELECT 1 FROM join_requests WHERE decided_by = users.id)
          AND NOT EXISTS (SELECT 1 FROM voice_restrictions WHERE moderator_id = users.id)
          AND NOT EXISTS (SELECT 1 FROM invite_links WHERE created_by = users.id)
      `).all(ourDomain) as Array<{ id: string }>).map(r => r.id);

      if (deletable.length > 0) {
        const dph = deletable.map(() => '?').join(',');
        // Explicit child cleanup for the cascade-declared tables too — FK
        // enforcement cannot be assumed ON.
        rawDb.prepare(`DELETE FROM dm_reactions WHERE user_id IN (${dph})`).run(...deletable);
        rawDb.prepare(`DELETE FROM reactions WHERE user_id IN (${dph})`).run(...deletable);
        rawDb.prepare(`DELETE FROM read_states WHERE user_id IN (${dph})`).run(...deletable);
        rawDb.prepare(`DELETE FROM users WHERE id IN (${dph})`).run(...deletable);
        deletedStubs = deletable.length;
      }
    })();
  }

  const skipped = allStubIds.length - deletedStubs;
  if (junkChannelIds.length > 0 || allStubIds.length > 0) {
    console.log(`[federation] Dead-incarnation sweep: removed ${junkChannelIds.length} channels, ${deletedStubs} self-homed stubs${skipped > 0 ? `, skipped ${skipped} still-referenced stubs` : ''}`);
  }
}

// ─── Replicated Profile Asset Backfill ──────────────────────────────────────
