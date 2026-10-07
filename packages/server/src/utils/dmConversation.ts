import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateSnowflake } from './snowflake.js';
import { insertDmMember, setDmMemberClosed } from './dmMemberClosed.js';

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

// ─── Read pointers ───────────────────────────────────────────────────────────

/**
 * Move one person's read pointer from (`from.userId`, `from.channelId`) to
 * (`to.userId`, `to.channelId`), for when their membership moves between rows
 * or local ids. Where `to` already has a pointer the newer of the two is kept
 * (message ids are snowflakes and compare as numbers, as the read-state
 * handlers compare them); `from`'s row is removed either way. A noop when
 * `from` has no pointer or is `to`.
 */
export function keepNewerReadPointer(
  rawDb: Database.Database,
  from: { userId: string; channelId: string },
  to: { userId: string; channelId: string },
): void {
  if (from.userId === to.userId && from.channelId === to.channelId) return;
  const read = rawDb.prepare(`SELECT last_read_message_id AS last, updated_at AS updatedAt FROM read_states WHERE user_id = ? AND channel_id = ?`);
  const moving = read.get(from.userId, from.channelId) as { last: string; updatedAt: number } | undefined;
  if (!moving) return;
  rawDb.prepare(`DELETE FROM read_states WHERE user_id = ? AND channel_id = ?`).run(from.userId, from.channelId);
  const held = read.get(to.userId, to.channelId) as { last: string; updatedAt: number } | undefined;
  if (!held) {
    rawDb.prepare(`INSERT INTO read_states (user_id, channel_id, last_read_message_id, updated_at) VALUES (?, ?, ?, ?)`)
      .run(to.userId, to.channelId, moving.last, moving.updatedAt);
    return;
  }
  if (isNewerMessageId(moving.last, held.last)) {
    rawDb.prepare(`UPDATE read_states SET last_read_message_id = ?, updated_at = ? WHERE user_id = ? AND channel_id = ?`)
      .run(moving.last, Math.max(moving.updatedAt, held.updatedAt), to.userId, to.channelId);
  }
}

/** Whether message id `a` is newer than `b`. Ids that are not numbers compare as text. */
function isNewerMessageId(a: string, b: string): boolean {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a > b;
  }
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
 *   each read pointer moves with its person, the newer kept where two meet
 *   (`keepNewerReadPointer`); the row's federation
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
  // row was open for them; anyone else moves over. Each read pointer follows
  // its person to the local id they keep (`keepNewerReadPointer`).
  const drop = rawDb.prepare(`DELETE FROM dm_members WHERE dm_channel_id = ? AND user_id = ?`);
  const move = rawDb.prepare(`UPDATE dm_members SET dm_channel_id = ? WHERE dm_channel_id = ? AND user_id = ?`);
  const keptIdOf = new Map<string, string>();
  for (const member of members) {
    const held = targetMembers.find(t => identityOfRow(t) === identityOfRow(member));
    if (held) {
      if (member.closed === 0 && held.closed !== 0) setDmMemberClosed(rawDb, targetId, held.user_id, false);
      drop.run(channelId, member.user_id);
      keptIdOf.set(member.user_id, held.user_id);
    } else {
      move.run(targetId, channelId, member.user_id);
    }
  }

  // read_states are keyed by (user_id, channel_id): every pointer on this row
  // moves to the target, under the local id its person keeps there.
  const pointers = rawDb.prepare(`SELECT user_id FROM read_states WHERE channel_id = ?`).all(channelId) as Array<{ user_id: string }>;
  for (const { user_id: userId } of pointers) {
    keepNewerReadPointer(rawDb, { userId, channelId }, { userId: keptIdOf.get(userId) ?? userId, channelId: targetId });
  }
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

// ─── Finding or creating a 1-on-1 ────────────────────────────────────────────

/** A database handle with its underlying better-sqlite3 connection. */
export interface DbWithClient {
  $client: Database.Database;
}

export interface OneOnOneOptions {
  /**
   * Whose membership this call opens when it adds one. `'both'`: the relay,
   * which delivers a message in the same step. `'first'`: an explicit open by
   * `a` (`POST /api/dm`, a space invite); `b` joins closed and the
   * conversation reaches their list with its first message, through the
   * resurface path every message send runs.
   */
  open: 'both' | 'first';
}

export interface OneOnOneResult {
  channelId: string;
  /** True when this call inserted the row. */
  created: boolean;
  /**
   * Other rows this call re-keyed or merged on the way (a row that held the
   * pair's key under other members). Their members' DM lists are stale until
   * the caller hands these to `announceDmReconcile`.
   */
  reconciled: DmReconcileResult[];
}

function channelHoldingKey(rawDb: Database.Database, key: string): string | undefined {
  return (rawDb.prepare(`SELECT id FROM dm_channels WHERE federated_id = ?`).get(key) as { id: string } | undefined)?.id;
}

/**
 * Whether every member row of a row belongs to one of the pair's two people
 * (possibly under more than one local id each), and none to anyone else.
 */
function holdsOnlyThePair(members: MemberIdentityRow[], a: HomeIdentified, b: HomeIdentified): boolean {
  const pair = [homeIdentityOf(a), homeIdentityOf(b)];
  return members.every(member => pair.includes(identityOfRow(member)));
}

/**
 * Leave one member row per person on a row: where a person has rows under
 * several local ids, the one under the pair's local id is kept (else the
 * first), the others are dropped, and the kept row is open when any of them
 * was.
 */
function collapseToOneRowPerPerson(rawDb: Database.Database, channelId: string, a: HomeIdentified, b: HomeIdentified): void {
  const byIdentity = new Map<string, MemberIdentityRow[]>();
  for (const member of membersWithIdentity(rawDb, channelId)) {
    const identity = identityOfRow(member);
    const rows = byIdentity.get(identity);
    if (rows) rows.push(member);
    else byIdentity.set(identity, [member]);
  }
  for (const rows of byIdentity.values()) {
    if (rows.length < 2) continue;
    const kept = rows.find(r => r.user_id === a.id || r.user_id === b.id) ?? rows[0]!;
    for (const row of rows) {
      if (row === kept) continue;
      rawDb.prepare(`DELETE FROM dm_members WHERE dm_channel_id = ? AND user_id = ?`).run(channelId, row.user_id);
      keepNewerReadPointer(rawDb, { userId: row.user_id, channelId }, { userId: kept.user_id, channelId });
    }
    if (kept.closed !== 0 && rows.some(r => r.closed === 0)) {
      setDmMemberClosed(rawDb, channelId, kept.user_id, false);
    }
  }
}

/**
 * Make a row's members exactly the pair: a pair member already present stays
 * as it is; a member row holding a pair member's home identity under another
 * local id is re-pointed to that member (its open state kept); a pair member
 * with neither is added, open or closed as `options` says.
 */
function alignToPair(rawDb: Database.Database, channelId: string, a: HomeIdentified, b: HomeIdentified, options: OneOnOneOptions): void {
  const members = membersWithIdentity(rawDb, channelId);
  for (const party of [a, b]) {
    if (members.some(m => m.user_id === party.id)) continue;
    const underOtherId = members.find(m => m.user_id !== a.id && m.user_id !== b.id && identityOfRow(m) === homeIdentityOf(party));
    if (underOtherId) {
      rawDb.prepare(`UPDATE dm_members SET user_id = ? WHERE dm_channel_id = ? AND user_id = ?`).run(party.id, channelId, underOtherId.user_id);
      keepNewerReadPointer(rawDb, { userId: underOtherId.user_id, channelId }, { userId: party.id, channelId });
      continue;
    }
    const closed = options.open === 'first' && party === b;
    insertDmMember(rawDb, channelId, party.id, { closed });
  }
}

/**
 * The 1-on-1 between local users `a` and `b`, created if there is none. The
 * only code that looks up or inserts a 1-on-1 row (ADR 0002); each caller
 * keeps its own side effects (reopening the caller, notifying anyone, late
 * binding a call). In one transaction:
 *
 * 1. The row holding `oneOnOneKey(a, b)` is the conversation. Its members are
 *    made the pair (`collapseToOneRowPerPerson`, then `alignToPair`); a 1-on-1
 *    never gets a third member. A row
 *    holding the key under someone else's membership has drifted: it is first
 *    moved to its own members' key (`reconcileDmChannelFederatedId`).
 * 2. Else a 1-on-1 row whose members are exactly `a` and `b` (one the startup
 *    backfill has not keyed yet) is keyed and returned.
 * 3. Else a new row is inserted with the key; `b` joins closed when `a` opens
 *    it (`options.open === 'first'`).
 *
 * Looking up by key first is what keeps a relay-created row with other member
 * rows from turning a local open into a second insert of the same key.
 */
export function findOrCreateOneOnOne(
  db: DbWithClient,
  a: HomeIdentified,
  b: HomeIdentified,
  options: OneOnOneOptions,
): OneOnOneResult {
  const rawDb = db.$client;
  const key = oneOnOneKey(a, b);

  return rawDb.transaction((): OneOnOneResult => {
    const reconciled: DmReconcileResult[] = [];
    const reconcile = (channelId: string): DmReconcileResult => {
      const result = reconcileDmChannelFederatedId(rawDb, channelId);
      if (result.action !== 'noop') reconciled.push(result);
      return result;
    };
    let keyed = channelHoldingKey(rawDb, key);
    if (keyed && !holdsOnlyThePair(membersWithIdentity(rawDb, keyed), a, b)) {
      reconcile(keyed);
      keyed = channelHoldingKey(rawDb, key);
      if (keyed && !holdsOnlyThePair(membersWithIdentity(rawDb, keyed), a, b)) {
        throw new Error(`DM channel ${keyed} holds the 1-on-1 key of ${a.id} and ${b.id} but other members, and cannot be re-keyed`);
      }
    }
    if (keyed) {
      collapseToOneRowPerPerson(rawDb, keyed, a, b);
      alignToPair(rawDb, keyed, a, b, options);
      return { channelId: keyed, created: false, reconciled };
    }

    const byMembers = (rawDb.prepare(`
      SELECT c.id, c.owner_id, c.federated_id FROM dm_channels c
      WHERE c.owner_id IS NULL AND c.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM dm_members m WHERE m.dm_channel_id = c.id AND m.user_id = ?)
        AND EXISTS (SELECT 1 FROM dm_members m WHERE m.dm_channel_id = c.id AND m.user_id = ?)
        AND (SELECT count(*) FROM dm_members m WHERE m.dm_channel_id = c.id) = 2
      ORDER BY c.created_at, c.id
    `).all(a.id, b.id) as Array<{ id: string; owner_id: string | null; federated_id: string | null }>)
      .find(mayBeOneOnOneRow);
    if (byMembers) {
      return { channelId: reconcile(byMembers.id).targetChannelId, created: false, reconciled };
    }

    const channelId = generateSnowflake();
    rawDb.prepare(`INSERT INTO dm_channels (id, owner_id, federated_id, created_at) VALUES (?, NULL, ?, ?)`).run(channelId, key, Date.now());
    insertDmMember(rawDb, channelId, a.id);
    insertDmMember(rawDb, channelId, b.id, { closed: options.open === 'first' });
    return { channelId, created: true, reconciled };
  })();
}
