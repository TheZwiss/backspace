import { getRawDb } from '../../db/index.js';
import { and, or } from 'drizzle-orm';
import { getOurIdentityDomain } from './identity.js';

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
