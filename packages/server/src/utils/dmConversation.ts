import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * DM conversation identity (docs/decisions/0002-dm-conversation-identity.md).
 *
 * A DM conversation has one key, `dm_channels.federated_id`, and this module
 * is the only code that computes or mints one. Every instance holding a copy
 * of a conversation stores the same key, which is how two instances' copies
 * (and a client connected to both) recognise each other.
 *
 * - A 1-on-1's key is derived from its two members' home identities
 *   (`oneOnOneKey`). Every 1-on-1 row stores it from insertion.
 * - A group's key is a random UUID (`mintGroupKey`), minted once, together
 *   with the owner home identity, when the group first gets a member homed
 *   elsewhere. A group no other instance holds keeps `NULL`.
 */

/** Anything with a local id and, when homed elsewhere, a home user id. */
export interface HomeIdentified {
  id: string;
  homeUserId: string | null;
}

/**
 * The id a user is known by on the instance that homes them: the home user
 * id of a user homed elsewhere, the local id of a native user.
 */
export function homeIdentityOf(user: HomeIdentified): string {
  return user.homeUserId || user.id;
}

/**
 * The key of the 1-on-1 between `a` and `b`: the first 32 hex characters of
 * SHA-256 over their two home identities, sorted and joined with ':'. Every
 * deployed instance and the web client's compatibility derivation compute
 * these exact bytes, so they can never change.
 */
export function oneOnOneKey(a: HomeIdentified, b: HomeIdentified): string {
  const sorted = [homeIdentityOf(a), homeIdentityOf(b)].sort();
  return crypto.createHash('sha256').update(sorted.join(':')).digest('hex').slice(0, 32);
}

/** A new group key. Minted once per group and never recomputed. */
export function mintGroupKey(): string {
  return crypto.randomUUID();
}

// ─── Keeping every 1-on-1 row on its key ─────────────────────────────────────

export interface DmReconcileResult {
  action: 'noop' | 'rekeyed' | 'merged';
  channelId: string;
  /** The row the conversation lives in afterwards (`channelId` unless merged). */
  targetChannelId: string;
  /** Local members of either row, who need their DM list refreshed. */
  affectedUserIds: string[];
}

interface MemberIdentityRow {
  user_id: string;
  home_user_id: string | null;
  closed: number;
}

function membersWithIdentity(rawDb: Database.Database, channelId: string): MemberIdentityRow[] {
  return rawDb.prepare(`
    SELECT m.user_id, u.home_user_id, m.closed FROM dm_members m JOIN users u ON u.id = m.user_id
    WHERE m.dm_channel_id = ?
  `).all(channelId) as MemberIdentityRow[];
}

function identityOfRow(row: MemberIdentityRow): string {
  return homeIdentityOf({ id: row.user_id, homeUserId: row.home_user_id });
}

/** The shape of a 1-on-1 key: 32 lowercase hex characters. A group key is a UUID. */
const ONE_ON_ONE_KEY_SHAPE = /^[0-9a-f]{32}$/;

/**
 * Whether a row that has no owner and two members is a 1-on-1. Its key must be
 * NULL or 1-on-1 shaped: a row holding a group key is a group copy, which up to
 * 1.6.0 the member_add bootstrap could create without an owner (when the group
 * named none, or the owner was a deleted identity). Such a row is never taken
 * for a 1-on-1, re-keyed or merged.
 */
export function mayBeOneOnOneRow(row: { owner_id: string | null; federated_id: string | null }): boolean {
  return row.owner_id === null && (row.federated_id === null || ONE_ON_ONE_KEY_SHAPE.test(row.federated_id));
}

/**
 * Give one 1-on-1 row (`mayBeOneOnOneRow`, exactly two members, not
 * soft-deleted) the key of its two members' current home identities. Groups
 * and any other row are a noop. When the row's key is already right this is a noop too.
 *
 * - No other row holds the right key: the row is re-keyed in place. This is
 *   what an unkeyed row (made while relay was off, or before every 1-on-1 was
 *   keyed at insert) and a row whose member's home identity changed
 *   (re-attach) get.
 * - Another row holds it (`idx_dm_federated` is unique): this row is merged
 *   into that one and deleted. Messages move; a member whose home identity the
 *   target already has is dropped rather than added, so the merged 1-on-1 keeps
 *   two members, and a member who had this row open has the target open;
 *   read states are deduplicated on their composite key; the row's federation
 *   mutation log and outbox entries are re-pointed to the target.
 *
 * Idempotent. Must run inside a transaction.
 */
export function reconcileDmChannelFederatedId(
  rawDb: Database.Database,
  channelId: string,
): DmReconcileResult {
  const noop: DmReconcileResult = { action: 'noop', channelId, targetChannelId: channelId, affectedUserIds: [] };

  const chan = rawDb.prepare(`SELECT id, federated_id, owner_id FROM dm_channels WHERE id = ? AND deleted_at IS NULL`).get(channelId) as
    { id: string; federated_id: string | null; owner_id: string | null } | undefined;
  if (!chan || !mayBeOneOnOneRow(chan)) return noop;

  const members = membersWithIdentity(rawDb, channelId);
  if (members.length !== 2) return noop;

  const expected = oneOnOneKey(
    { id: members[0]!.user_id, homeUserId: members[0]!.home_user_id },
    { id: members[1]!.user_id, homeUserId: members[1]!.home_user_id },
  );
  if (expected === chan.federated_id) return noop;

  const target = rawDb.prepare(`SELECT id FROM dm_channels WHERE federated_id = ? AND id != ?`).get(expected, channelId) as
    { id: string } | undefined;

  if (!target) {
    rawDb.prepare(`UPDATE dm_channels SET federated_id = ? WHERE id = ?`).run(expected, channelId);
    return { action: 'rekeyed', channelId, targetChannelId: channelId, affectedUserIds: members.map(m => m.user_id) };
  }

  // Merge this row INTO the target, then delete it.
  const targetId = target.id;
  const targetMembers = membersWithIdentity(rawDb, targetId);
  const affected = Array.from(new Set([...members.map(m => m.user_id), ...targetMembers.map(m => m.user_id)]));

  // Messages: globally-unique ids, straight move (attachments and dm_reactions
  // reference dm_message_id and follow).
  rawDb.prepare(`UPDATE dm_messages SET dm_channel_id = ? WHERE dm_channel_id = ?`).run(targetId, channelId);

  // Members: one row per home identity. A person the target already holds
  // (under this local id or another) keeps the target's row, opened when this
  // row was open for them; anyone else moves over.
  const reopen = rawDb.prepare(`UPDATE dm_members SET closed = 0 WHERE dm_channel_id = ? AND user_id = ?`);
  const drop = rawDb.prepare(`DELETE FROM dm_members WHERE dm_channel_id = ? AND user_id = ?`);
  const move = rawDb.prepare(`UPDATE dm_members SET dm_channel_id = ? WHERE dm_channel_id = ? AND user_id = ?`);
  for (const member of members) {
    const held = targetMembers.find(t => identityOfRow(t) === identityOfRow(member));
    if (held) {
      if (member.closed === 0 && held.closed !== 0) reopen.run(targetId, held.user_id);
      drop.run(channelId, member.user_id);
    } else {
      move.run(targetId, channelId, member.user_id);
    }
  }

  // read_states: keyed by channel_id; dedupe on (user_id, channel_id), then repoint.
  rawDb.prepare(`DELETE FROM read_states WHERE channel_id = ? AND user_id IN (SELECT user_id FROM read_states WHERE channel_id = ?)`).run(channelId, targetId);
  rawDb.prepare(`UPDATE read_states SET channel_id = ? WHERE channel_id = ?`).run(targetId, channelId);
  // The federation mutation log and outbox name a DM by its local channel id.
  // They follow the messages, so the peer catch-up sync (which reads the log
  // by the ids of live channels) and pending deliveries still find them.
  rawDb.prepare(`UPDATE federation_mutation_log SET context_id = ? WHERE context_id = ? AND context_type = 'dm'`).run(targetId, channelId);
  rawDb.prepare(`UPDATE federation_outbox SET context_id = ? WHERE context_id = ? AND context_type = 'dm'`).run(targetId, channelId);
  rawDb.prepare(`DELETE FROM dm_channels WHERE id = ?`).run(channelId);

  return { action: 'merged', channelId, targetChannelId: targetId, affectedUserIds: affected };
}

/**
 * Startup sweep, run by `initDatabase` on every boot (ADR 0002, "Backfill"):
 * every 1-on-1 row whose key is NULL or differs from the key of its members
 * gets the right one, through `reconcileDmChannelFederatedId`. Heals rows made
 * while relay was off, legacy rows from before every 1-on-1 was keyed at
 * insert, and rows whose member's home identity changed, whether or not the
 * federation workers run. Synchronous and idempotent; a noop on a clean DB.
 */
export function backfillOneOnOneKeys(
  rawDb: Database.Database,
  options: {
    /**
     * Runs once, before the first change, only when the sweep is about to
     * re-key or merge a row (`initDatabase` takes a database snapshot here).
     * Not called on a database with nothing to change.
     */
    beforeChanges?: () => void;
  } = {},
): void {
  const rows = rawDb.prepare(`
    SELECT c.id AS channel_id, c.federated_id, m.user_id, u.home_user_id
    FROM dm_channels c
    JOIN dm_members m ON m.dm_channel_id = c.id
    JOIN users u ON u.id = m.user_id
    WHERE c.owner_id IS NULL AND c.deleted_at IS NULL
    ORDER BY c.created_at, c.id
  `).all() as Array<{ channel_id: string; federated_id: string | null; user_id: string; home_user_id: string | null }>;
  const oneOnOneRows = rows.filter(r => mayBeOneOnOneRow({ owner_id: null, federated_id: r.federated_id }));

  const byChannel = new Map<string, { key: string | null; members: HomeIdentified[] }>();
  for (const r of oneOnOneRows) {
    const entry = byChannel.get(r.channel_id);
    const member = { id: r.user_id, homeUserId: r.home_user_id };
    if (entry) entry.members.push(member);
    else byChannel.set(r.channel_id, { key: r.federated_id, members: [member] });
  }
  const candidates = [...byChannel.entries()]
    .filter(([, c]) => c.members.length === 2 && oneOnOneKey(c.members[0]!, c.members[1]!) !== c.key)
    .map(([id]) => id);
  if (candidates.length === 0) return;
  options.beforeChanges?.();

  let rekeyed = 0;
  let merged = 0;
  rawDb.transaction(() => {
    for (const id of candidates) {
      // A merge earlier in this loop may have deleted or changed this row;
      // reconcile re-reads it and is a noop for a missing or settled row.
      const r = reconcileDmChannelFederatedId(rawDb, id);
      if (r.action === 'rekeyed') rekeyed++;
      else if (r.action === 'merged') merged++;
    }
  })();

  if (rekeyed > 0 || merged > 0) {
    console.log(`[db] 1-on-1 DM key backfill: keyed ${rekeyed}, merged ${merged}`);
  }
}
