import crypto from 'crypto';
import { eq, or, and, inArray, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

export interface DeletionBroadcastTargets {
  /** Space IDs the user is a member of (for member_left broadcasts) */
  memberSpaceIds: string[];
  /** All user IDs who may have cached data for this user (for user_updated broadcast) */
  targetUserIds: Set<string>;
}

/**
 * Collect the set of user IDs who should receive a user_updated broadcast
 * for a given user. Includes: space co-members, DM co-members, and friends.
 * Does NOT include the user themselves — callers add self if needed.
 */
export function collectProfileBroadcastTargetIds(uid: string): Set<string> {
  const db = getDb();
  const targetUserIds = new Set<string>();

  // 1. All users who share a space with this user
  const memberSpaceIds = db.select({ spaceId: schema.spaceMembers.spaceId })
    .from(schema.spaceMembers)
    .where(eq(schema.spaceMembers.userId, uid))
    .all()
    .map(m => m.spaceId);

  if (memberSpaceIds.length > 0) {
    const coMembers = db.select({ userId: schema.spaceMembers.userId })
      .from(schema.spaceMembers)
      .where(inArray(schema.spaceMembers.spaceId, memberSpaceIds))
      .all();
    for (const m of coMembers) targetUserIds.add(m.userId);
  }

  // 2. All DM co-members
  const dmMemberships = db.select({ dmChannelId: schema.dmMembers.dmChannelId })
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.userId, uid))
    .all();
  if (dmMemberships.length > 0) {
    const dmChannelIds = dmMemberships.map(d => d.dmChannelId);
    const dmCoMembers = db.select({ userId: schema.dmMembers.userId })
      .from(schema.dmMembers)
      .where(inArray(schema.dmMembers.dmChannelId, dmChannelIds))
      .all();
    for (const m of dmCoMembers) targetUserIds.add(m.userId);
  }

  // 3. All friends
  const friendRows = db.select().from(schema.friends)
    .where(or(eq(schema.friends.userId, uid), eq(schema.friends.friendId, uid)))
    .all();
  for (const fr of friendRows) {
    targetUserIds.add(fr.userId === uid ? fr.friendId : fr.userId);
  }

  // Remove the target user themselves — callers decide whether to include self
  targetUserIds.delete(uid);

  return targetUserIds;
}

/**
 * Collect broadcast targets for a user deletion. Must be called BEFORE
 * tombstoneUser() since that transaction deletes the membership/friend/DM rows.
 *
 * Collects: space co-members, DM co-members, and friends.
 * sendToUser() no-ops for offline users, so no online-filtering needed.
 */
export function collectDeletionBroadcastTargets(uid: string): DeletionBroadcastTargets {
  const db = getDb();

  // Collect space IDs (needed for member_left broadcasts — not part of the shared helper)
  const memberSpaceIds = db.select({ spaceId: schema.spaceMembers.spaceId })
    .from(schema.spaceMembers)
    .where(eq(schema.spaceMembers.userId, uid))
    .all()
    .map(m => m.spaceId);

  const targetUserIds = collectProfileBroadcastTargetIds(uid);

  return { memberSpaceIds, targetUserIds };
}

export interface TombstoneOptions {
  /** When false, skip space message/reaction deletion (soft-delete mode). Orphaned DM cleanup always runs. Default: true */
  purgeContent?: boolean;
}

/**
 * Tombstone a user account: removes them from all spaces, DMs, friends,
 * roles, reactions, folders, bans, voice restrictions, channel overrides,
 * transfers group DM ownership, cleans up orphaned DMs, and marks the
 * user row as deleted.
 *
 * Returns a list of filenames to delete from disk (avatar, banner,
 * orphaned DM attachments). The caller is responsible for disk cleanup
 * and WebSocket disconnection after calling this.
 */
export function tombstoneUser(uid: string, options?: TombstoneOptions): string[] {
  const db = getDb();

  const user = db.select().from(schema.users).where(eq(schema.users.id, uid)).get();
  if (!user) return [];

  const filesToDelete: string[] = [];
  if (user.avatar) filesToDelete.push(user.avatar);
  if (user.banner) filesToDelete.push(user.banner);

  const purge = options?.purgeContent !== false; // default true

  // Find group DMs this user owns so we can transfer ownership
  const ownedGroupDms = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.ownerId, uid))
    .all();

  db.transaction((tx) => {
    // Remove from spaces, roles, friends, DMs, read states, reactions, folders
    tx.delete(schema.spaceMembers).where(eq(schema.spaceMembers.userId, uid)).run();
    tx.delete(schema.memberRoles).where(eq(schema.memberRoles.userId, uid)).run();
    tx.delete(schema.friends).where(or(eq(schema.friends.userId, uid), eq(schema.friends.friendId, uid))).run();
    tx.delete(schema.friendRequests).where(or(eq(schema.friendRequests.fromId, uid), eq(schema.friendRequests.toId, uid))).run();
    // DM membership: keep the row for 1-on-1 DMs (ownerId NULL) so the thread
    // survives as a readable "Deleted User" thread; drop it for group DMs.
    const userDmChannelIds = tx.select({ dmChannelId: schema.dmMembers.dmChannelId })
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.userId, uid))
      .all()
      .map(r => r.dmChannelId);
    if (userDmChannelIds.length > 0) {
      const groupDmChannelIds = tx.select({ id: schema.dmChannels.id })
        .from(schema.dmChannels)
        .where(and(inArray(schema.dmChannels.id, userDmChannelIds), isNotNull(schema.dmChannels.ownerId)))
        .all()
        .map(c => c.id);
      if (groupDmChannelIds.length > 0) {
        tx.delete(schema.dmMembers).where(and(
          eq(schema.dmMembers.userId, uid),
          inArray(schema.dmMembers.dmChannelId, groupDmChannelIds),
        )).run();
      }
    }
    tx.delete(schema.readStates).where(eq(schema.readStates.userId, uid)).run();
    if (purge) {
      tx.delete(schema.reactions).where(eq(schema.reactions.userId, uid)).run();
      tx.delete(schema.dmReactions).where(eq(schema.dmReactions.userId, uid)).run();
    }
    tx.delete(schema.spaceFolders).where(eq(schema.spaceFolders.userId, uid)).run();

    // Conditional deletes for tables that may reference userId
    try { tx.delete(schema.bans).where(eq(schema.bans.userId, uid)).run(); } catch { /* table may not exist */ }
    try { tx.delete(schema.joinRequests).where(eq(schema.joinRequests.userId, uid)).run(); } catch { /* table may not exist */ }
    try { tx.delete(schema.voiceRestrictions).where(eq(schema.voiceRestrictions.userId, uid)).run(); } catch { /* table may not exist */ }

    // Nullify moderator references pointing to this user
    try {
      tx.update(schema.bans).set({ bannedBy: null }).where(eq(schema.bans.bannedBy, uid)).run();
    } catch { /* table may not exist */ }
    try {
      tx.update(schema.voiceRestrictions).set({ moderatorId: null }).where(eq(schema.voiceRestrictions.moderatorId, uid)).run();
    } catch { /* table may not exist */ }
    try {
      tx.update(schema.joinRequests).set({ decidedBy: null }).where(eq(schema.joinRequests.decidedBy, uid)).run();
    } catch { /* table may not exist */ }

    // Remove member-type channel overrides for this user
    tx.delete(schema.channelOverrides).where(
      and(eq(schema.channelOverrides.targetType, 'member'), eq(schema.channelOverrides.targetId, uid))
    ).run();

    // Transfer ownership of group DMs to the next remaining member.
    // Invariant: ownership must never transfer to a tombstoned member — join
    // users and require isDeleted=0 so a dead incarnation can't become owner.
    for (const { id: dmId } of ownedGroupDms) {
      const nextMember = tx.select({ userId: schema.dmMembers.userId })
        .from(schema.dmMembers)
        .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
        .where(and(
          eq(schema.dmMembers.dmChannelId, dmId),
          eq(schema.users.isDeleted, 0),
        ))
        .limit(1)
        .get();
      if (nextMember) {
        tx.update(schema.dmChannels)
          .set({ ownerId: nextMember.userId })
          .where(eq(schema.dmChannels.id, dmId))
          .run();
      }
    }

    // Purge DMs that are dead after this deletion: among the channels this user
    // was in, those with zero LIVE members. The uid being tombstoned right now
    // still reads isDeleted=0 (its row is updated below), so it is excluded
    // explicitly — this keeps a Deleted<->Survivor 1-on-1 but purges a
    // Deleted<->Deleted one. Scoped to the user's channels: only their
    // membership changed here, so only these can newly become dead.
    const orphanedDmIds = userDmChannelIds.filter(dmId => {
      const liveOthers = tx.select({ userId: schema.dmMembers.userId })
        .from(schema.dmMembers)
        .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
        .where(and(
          eq(schema.dmMembers.dmChannelId, dmId),
          eq(schema.users.isDeleted, 0),
        ))
        .all()
        .filter(m => m.userId !== uid);
      return liveOthers.length === 0;
    });

    for (const dmId of orphanedDmIds) {
      const msgIds = tx.select({ id: schema.dmMessages.id })
        .from(schema.dmMessages)
        .where(eq(schema.dmMessages.dmChannelId, dmId))
        .all()
        .map(m => m.id);

      if (msgIds.length > 0) {
        const dmAttachments = tx.select({ filename: schema.attachments.filename })
          .from(schema.attachments)
          .where(inArray(schema.attachments.dmMessageId, msgIds))
          .all();
        for (const att of dmAttachments) filesToDelete.push(att.filename);

        tx.delete(schema.attachments).where(inArray(schema.attachments.dmMessageId, msgIds)).run();
        tx.delete(schema.dmReactions).where(inArray(schema.dmReactions.dmMessageId, msgIds)).run();
      }
      tx.delete(schema.dmChannels).where(eq(schema.dmChannels.id, dmId)).run();
    }

    // Purge mode: delete the user's space messages and their attachments
    if (purge) {
      const userMessageIds = tx.select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.userId, uid))
        .all()
        .map(m => m.id);

      if (userMessageIds.length > 0) {
        // Collect attachment files for disk cleanup
        const msgAttachments = tx.select({ filename: schema.attachments.filename })
          .from(schema.attachments)
          .where(inArray(schema.attachments.messageId, userMessageIds))
          .all();
        for (const att of msgAttachments) filesToDelete.push(att.filename);

        // Delete attachments, embeds, then messages (FK order)
        tx.delete(schema.attachments).where(inArray(schema.attachments.messageId, userMessageIds)).run();
        tx.delete(schema.embeds).where(inArray(schema.embeds.messageId, userMessageIds)).run();
        tx.delete(schema.messages).where(eq(schema.messages.userId, uid)).run();
      }
    }

    // Tombstone user row — rename username to free it for reuse
    tx.update(schema.users).set({
      username: `!deleted:${uid}`,
      passwordHash: crypto.randomBytes(32).toString('hex'),
      displayName: null,
      avatar: null,
      banner: null,
      bio: null,
      customStatus: null,
      accentColor: null,
      avatarColor: null,
      replicatedInstances: '[]',
      isDeleted: 1,
      status: 'offline',
      isAdmin: 0,
      federationHomeOrphaned: 0,
    }).where(eq(schema.users.id, uid)).run();
  });

  return filesToDelete;
}
