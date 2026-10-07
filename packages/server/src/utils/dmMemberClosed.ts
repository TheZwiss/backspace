import type Database from 'better-sqlite3';

/**
 * The only writer of `dm_members.closed` and `dm_members.closed_changed_at`.
 *
 * A member's `closed` flag is kept on every instance that holds a copy of the
 * conversation, and a peer's dm_close / dm_reopen can reach a copy more than
 * once, or after the member's state here moved on (a pull replays the peer's
 * mutation log; a later message reopened the conversation here). The flag is
 * therefore last-writer-wins on `closed_changed_at`:
 *
 * - a new member row takes its insertion time: a close or reopen from before
 *   the membership began concerns an earlier membership and never applies;
 * - a local change (the member closes or reopens, a message reopens it) takes
 *   the local time of the change;
 * - a relayed dm_close / dm_reopen applies only when its timestamp is newer
 *   than the row's, and then takes that timestamp.
 *
 * Local times and a peer's timestamps come from different clocks. The rule
 * only has to order a replayed event against a change made after it was first
 * applied, which is minutes to days apart, not milliseconds.
 *
 * Each helper takes the raw connection (a drizzle handle's `$client`). The app
 * has one, which drizzle shares, so the helpers work inside a drizzle or a raw
 * transaction.
 */

/** Add `userId` to `channelId`, open unless `closed`. The row's state dates from `at`. */
export function insertDmMember(
  rawDb: Database.Database,
  channelId: string,
  userId: string,
  options: { closed?: boolean; at?: number } = {},
): void {
  rawDb
    .prepare('INSERT INTO dm_members (dm_channel_id, user_id, closed, closed_changed_at) VALUES (?, ?, ?, ?)')
    .run(channelId, userId, options.closed ? 1 : 0, options.at ?? Date.now());
}

/**
 * A local change of `userId`'s `closed` state in `channelId`: the member closed
 * or reopened it here, or something done here reopened it. Returns whether the
 * row's state changed (false when it was already so, or there is no such row).
 */
export function setDmMemberClosed(
  rawDb: Database.Database,
  channelId: string,
  userId: string,
  closed: boolean,
  at: number = Date.now(),
): boolean {
  const result = rawDb
    .prepare('UPDATE dm_members SET closed = ?, closed_changed_at = ? WHERE dm_channel_id = ? AND user_id = ? AND closed IS NOT ?')
    .run(closed ? 1 : 0, at, channelId, userId, closed ? 1 : 0);
  return result.changes > 0;
}

/**
 * Reopen `channelId` for every member who has it closed, as a local change at
 * `at`. With `closedBefore`, only members whose state dates from before it are
 * reopened: a relayed message reopens a conversation for a member who closed
 * it before the message was written, not for one who closed it after (a pull
 * can deliver an old message late). Returns the user ids reopened.
 */
export function reopenClosedDmMembers(
  rawDb: Database.Database,
  channelId: string,
  options: { at?: number; closedBefore?: number } = {},
): string[] {
  const at = options.at ?? Date.now();
  const rows = (options.closedBefore === undefined
    ? rawDb.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ? AND closed = 1').all(channelId)
    : rawDb
      .prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ? AND closed = 1 AND closed_changed_at < ?')
      .all(channelId, options.closedBefore)) as Array<{ user_id: string }>;
  const reopen = rawDb.prepare(
    'UPDATE dm_members SET closed = 0, closed_changed_at = ? WHERE dm_channel_id = ? AND user_id = ? AND closed = 1',
  );
  const reopened: string[] = [];
  for (const row of rows) {
    if (reopen.run(at, channelId, row.user_id).changes > 0) reopened.push(row.user_id);
  }
  return reopened;
}

/** What a relayed dm_close / dm_reopen did to a member row. */
export type RelayedClosedOutcome =
  /** The row took the event's state and it differs from before: tell the member's clients. */
  | 'changed'
  /** The event is the newest word on the row, which already had that state. */
  | 'unchanged'
  /** The row's state is newer than the event: nothing was written. */
  | 'stale'
  /** No member row for this user in this conversation. */
  | 'not_member';

/**
 * Apply a relayed dm_close (`closed`) or dm_reopen (`!closed`) with timestamp
 * `eventTs` to `userId`'s row in `channelId`, last-writer-wins.
 */
export function applyRelayedDmMemberClosed(
  rawDb: Database.Database,
  channelId: string,
  userId: string,
  closed: boolean,
  eventTs: number,
): RelayedClosedOutcome {
  const row = rawDb
    .prepare('SELECT closed, closed_changed_at FROM dm_members WHERE dm_channel_id = ? AND user_id = ?')
    .get(channelId, userId) as { closed: number | null; closed_changed_at: number } | undefined;
  if (!row) return 'not_member';
  if (eventTs <= row.closed_changed_at) return 'stale';
  rawDb
    .prepare('UPDATE dm_members SET closed = ?, closed_changed_at = ? WHERE dm_channel_id = ? AND user_id = ?')
    .run(closed ? 1 : 0, eventTs, channelId, userId);
  const wasClosed = row.closed === 1;
  return wasClosed === closed ? 'unchanged' : 'changed';
}
