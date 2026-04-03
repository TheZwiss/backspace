import crypto from 'crypto';
import { eq, or, and, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

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
    tx.delete(schema.dmMembers).where(eq(schema.dmMembers.userId, uid)).run();
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

    // Transfer ownership of group DMs to the next remaining member
    for (const { id: dmId } of ownedGroupDms) {
      const nextMember = tx.select({ userId: schema.dmMembers.userId })
        .from(schema.dmMembers)
        .where(eq(schema.dmMembers.dmChannelId, dmId))
        .limit(1)
        .get();
      if (nextMember) {
        tx.update(schema.dmChannels)
          .set({ ownerId: nextMember.userId })
          .where(eq(schema.dmChannels.id, dmId))
          .run();
      }
    }

    // Clean up orphaned DM channels (zero members after our removal) — always runs,
    // orphaned channels are unreachable garbage regardless of purge mode
    const orphanedDmIds = tx.select({ id: schema.dmChannels.id })
      .from(schema.dmChannels)
      .all()
      .filter(dc => {
        const memberCount = tx.select({ id: schema.dmMembers.dmChannelId })
          .from(schema.dmMembers)
          .where(eq(schema.dmMembers.dmChannelId, dc.id))
          .all()
          .length;
        return memberCount === 0;
      })
      .map(dc => dc.id);

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
    }).where(eq(schema.users.id, uid)).run();
  });

  return filesToDelete;
}
