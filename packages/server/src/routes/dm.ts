import type { FastifyInstance } from 'fastify';
import { eq, and, or, desc, lt, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isDmMember } from '../utils/permissions.js';
import { connectionManager } from '../ws/handler.js';
import {
  MAX_MESSAGE_LENGTH,
  type DmChannel,
  type DmMessage,
  type DmMessageWithUser,
  type CreateDmRequest,
  type CreateGroupDmRequest,
  type CreateDmMessageRequest,
  type AddDmMemberRequest,
  type PaginatedQuery,
  type Attachment,
  type Reaction,
  type Embed,
  type SpaceInviteRequest,
  type SpaceInviteResponse,
  type SpaceInviteSystemPayload,
} from '@backspace/shared';
import { fetchSpaceInviteSnapshot, getLocalInviteSnapshot } from '../utils/spaceInviteSnapshot.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { deleteAttachmentFiles, deleteUploadFile, deleteAttachmentByFilename } from '../utils/fileCleanup.js';
import { isValidAssetUrl } from './users.js';
import {
  GROUP_DM_NAME_MIN_LENGTH,
  GROUP_DM_NAME_MAX_LENGTH,
  GROUP_DM_ICON_MAX_BYTES,
  GROUP_DM_ICON_MIME_PREFIX,
} from '@backspace/shared/src/constants.js';
import { fetchDmEmbedsForMessages, resolveEmbeds, reResolveEmbeds, embedRowToEmbed } from '../utils/embedResolver.js';
import {
  appendMutationLog,
  queueOutboxEvent,
  queueDmRelay,
  queueDmCloseRelay,
  queueGroupMetadataRelay,
  getDmParticipants,
  getGroupDmTargetOrigins,
  isFederationRelayEnabled,
  computeFederatedId,
  sendTypingRelay,
  normalizeIconForWire,
} from '../utils/federationOutbox.js';
import { getOurOrigin } from '../utils/federationAuth.js';
import type { FederationRelayEvent } from '@backspace/shared';
import { resolveLocalUser, resolveOrCreateReplicatedUser } from './federation.js';

/**
 * Batch-fetch reactions for a set of DM message IDs.
 * Returns a map from dmMessageId to Reaction[].
 */
export function fetchDmReactionsForMessages(dmMessageIds: string[]): Map<string, Reaction[]> {
  if (dmMessageIds.length === 0) return new Map();
  const db = getDb();
  const reactionRows = db.select()
    .from(schema.dmReactions)
    .where(inArray(schema.dmReactions.dmMessageId, dmMessageIds))
    .all();

  // Batch fetch users for reactions
  const reactionUserIds = [...new Set(reactionRows.map(r => r.userId))];
  const reactionUsers = reactionUserIds.length > 0
    ? db.select().from(schema.users).where(inArray(schema.users.id, reactionUserIds)).all()
    : [];
  const reactionUserMap = new Map(reactionUsers.map(u => [u.id, u]));

  const map = new Map<string, Reaction[]>();
  for (const r of reactionRows) {
    const user = reactionUserMap.get(r.userId);
    const reaction: Reaction = {
      id: r.id,
      messageId: r.dmMessageId,
      userId: r.userId,
      emoji: r.emoji,
      createdAt: r.createdAt,
      user: user ? sanitizeUser(user) : undefined,
    };
    if (!map.has(r.dmMessageId)) {
      map.set(r.dmMessageId, []);
    }
    map.get(r.dmMessageId)!.push(reaction);
  }
  return map;
}

/**
 * Pure transformer: builds a DmMessageWithUser from pre-fetched data.
 */
export function buildDmMessageWithUser(
  message: typeof schema.dmMessages.$inferSelect,
  user: typeof schema.users.$inferSelect,
  attachmentRows: (typeof schema.attachments.$inferSelect)[],
  reactions: Reaction[] = [],
  replyTo: DmMessageWithUser | null = null,
  embedRows: (typeof schema.embeds.$inferSelect)[] = [],
): DmMessageWithUser {
  return {
    id: message.id,
    dmChannelId: message.dmChannelId,
    userId: message.userId,
    replyToId: message.replyToId,
    content: message.content,
    type: (message.type ?? 'user') as 'user' | 'system',
    editedAt: message.editedAt,
    createdAt: message.createdAt,
    sourceMessageId: message.sourceMessageId ?? null,
    sourceInstance: message.sourceInstance ?? null,
    user: sanitizeUser(user),
    attachments: attachmentRows.map(a => ({
      id: a.id,
      messageId: a.dmMessageId ?? message.id,
      filename: a.filename,
      originalName: a.originalName,
      mimetype: a.mimetype,
      size: a.size,
      thumbnailFilename: a.thumbnailFilename ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
      duration: a.duration ?? null,
      federationStatus: a.federationStatus ?? null,
      federationMeta: a.federationMeta ?? null,
      createdAt: a.createdAt,
    })),
    embeds: embedRows.map(e => embedRowToEmbed(e)),
    reactions,
    replyTo,
  };
}

/**
 * Fetches a DM message by ID and hydrates it with user, attachments, reactions, and replyTo.
 */
export function getDmMessageWithUser(dmMessageId: string): DmMessageWithUser | null {
  const db = getDb();
  const message = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, dmMessageId)).get();
  if (!message) return null;

  const user = db.select().from(schema.users).where(eq(schema.users.id, message.userId)).get();
  if (!user) return null;

  const attachmentRows = db.select()
    .from(schema.attachments)
    .where(eq(schema.attachments.dmMessageId, dmMessageId))
    .all();

  const embedRows = db.select()
    .from(schema.embeds)
    .where(eq(schema.embeds.dmMessageId, dmMessageId))
    .all();

  const reactionsMap = fetchDmReactionsForMessages([dmMessageId]);
  const reactions = reactionsMap.get(dmMessageId) ?? [];

  let replyTo: DmMessageWithUser | null = null;
  if (message.replyToId) {
    const replyMsg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, message.replyToId)).get();
    if (replyMsg) {
      const replyUser = db.select().from(schema.users).where(eq(schema.users.id, replyMsg.userId)).get();
      if (replyUser) {
        replyTo = {
          id: replyMsg.id,
          dmChannelId: replyMsg.dmChannelId,
          userId: replyMsg.userId,
          replyToId: replyMsg.replyToId,
          content: replyMsg.content,
          editedAt: replyMsg.editedAt,
          createdAt: replyMsg.createdAt,
          user: sanitizeUser(replyUser),
          attachments: [],
          embeds: [],
          reactions: [],
        };
      }
    }
  }

  return buildDmMessageWithUser(message, user, attachmentRows, reactions, replyTo, embedRows);
}

/**
 * Broadcasts a DM message to all members of a DM channel.
 * For members who have closed the channel (closed=1), also sends a
 * dm_channel_created event to resurface the channel in their sidebar,
 * and flips their closed flag back to 0.
 */
export function broadcastDmMessage(dmChannelId: string, message: DmMessageWithUser): void {
  const db = getDb();
  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  // Clear typing indicator for the message author — the message itself proves they stopped
  for (const member of dmMembers) {
    if (member.userId !== message.userId) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_typing_stop',
        dmChannelId,
        userId: message.userId,
      });
    }
  }

  // Relay typing stop to remote peers (fire-and-forget)
  sendTypingRelay(dmChannelId, 'dm_typing_stop', message.userId);

  for (const member of dmMembers) {
    // If this member had closed the DM, resurface it first
    if (member.closed === 1) {
      db.update(schema.dmMembers)
        .set({ closed: 0 })
        .where(and(
          eq(schema.dmMembers.dmChannelId, dmChannelId),
          eq(schema.dmMembers.userId, member.userId),
        ))
        .run();

      // Build and send dm_channel_created so their sidebar picks it up
      const allMemberRows = db.select()
        .from(schema.dmMembers)
        .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
        .all();
      const memberUserIds = allMemberRows.map(m => m.userId);
      const users = memberUserIds.length > 0
        ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
        : [];

      const dmChannel = db.select()
        .from(schema.dmChannels)
        .where(and(eq(schema.dmChannels.id, dmChannelId), isNull(schema.dmChannels.deletedAt)))
        .get();

      if (dmChannel) {
        connectionManager.sendToUser(member.userId, {
          type: 'dm_channel_created',
          dmChannel: {
            id: dmChannel.id,
            ownerId: dmChannel.ownerId ?? null,
            federatedId: dmChannel.federatedId ?? null,
            createdAt: dmChannel.createdAt,
            members: users.map(u => sanitizeUser(u)),
            lastMessage: message,
          },
        });
      }
    }

    connectionManager.sendToUser(member.userId, {
      type: 'dm_message_created',
      message,
    });
  }
}

/**
 * Find the existing 1-on-1 DM channel between two users, reopening it if
 * the caller had it soft-closed. Creates a new channel atomically when none
 * exists. Returns the channel id.
 *
 * Mirrors the dedup-or-create behavior of the existing `POST /api/dm`
 * handler, including:
 *  - skipping group DMs (ownerId !== null) and channels with !== 2 members
 *  - excluding soft-deleted channels
 *  - reopening on the caller side and queueing a `dm_reopen` relay
 *  - computing a deterministic `federatedId` when either party is federated
 *  - notifying the target on a fresh create with the same `dm_channel_created`
 *    payload shape (`id`, `ownerId`, `federatedId`, `createdAt`, `members`,
 *    `lastMessage: null`).
 *
 * NOTE: This helper is intentionally duplicated from `POST /api/dm` rather
 * than refactored out of it — mixing a behavior-preserving rewrite of a
 * heavily-used path with new feature work is the regression pattern this
 * codebase avoids.
 */
export function ensureOneOnOneDmChannel(
  callerId: string,
  targetUser: typeof schema.users.$inferSelect,
  db: ReturnType<typeof getDb>,
): string {
  // 1. Look for an existing 1-on-1 channel between caller and target.
  const callerMemberships = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.userId, callerId))
    .all();

  for (const membership of callerMemberships) {
    const otherMember = db.select()
      .from(schema.dmMembers)
      .where(and(
        eq(schema.dmMembers.dmChannelId, membership.dmChannelId),
        eq(schema.dmMembers.userId, targetUser.id),
      ))
      .get();
    if (!otherMember) continue;

    // Only match 1-on-1 DMs (exactly 2 members). Skip group DMs that
    // happen to include the target user.
    const memberCount = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, membership.dmChannelId))
      .all()
      .length;
    if (memberCount !== 2) continue;

    const dmChannel = db.select()
      .from(schema.dmChannels)
      .where(and(
        eq(schema.dmChannels.id, membership.dmChannelId),
        isNull(schema.dmChannels.deletedAt),
      ))
      .get();
    if (!dmChannel) continue;
    if (dmChannel.ownerId !== null) continue; // belt-and-braces: skip group DMs

    // Reopen if caller had it closed
    if (membership.closed === 1) {
      db.update(schema.dmMembers)
        .set({ closed: 0 })
        .where(and(
          eq(schema.dmMembers.dmChannelId, membership.dmChannelId),
          eq(schema.dmMembers.userId, callerId),
        ))
        .run();

      // Relay reopen to federated peers
      queueDmCloseRelay(membership.dmChannelId, callerId, 'dm_reopen');
    }
    return dmChannel.id;
  }

  // 2. Create new channel atomically.
  const dmChannelId = generateSnowflake();
  const now = Date.now();

  // Compute deterministic federatedId for federated 1-on-1 DMs so that the
  // S2S relay can find this channel when the reply arrives, preventing duplicates.
  let federatedId: string | null = null;
  if (isFederationRelayEnabled()) {
    const callerUser = db.select().from(schema.users).where(eq(schema.users.id, callerId)).get();
    const callerHomeUserId = callerUser?.homeUserId || callerId;
    const targetHomeUserId = targetUser.homeUserId || targetUser.id;
    const callerHomeInstance = callerUser?.homeInstance || null;
    const targetHomeInstance = targetUser.homeInstance || null;

    if (callerHomeInstance || targetHomeInstance) {
      federatedId = computeFederatedId(callerHomeUserId, targetHomeUserId);
    }
  }

  db.transaction((tx) => {
    tx.insert(schema.dmChannels).values({
      id: dmChannelId,
      ownerId: null,
      federatedId,
      createdAt: now,
    }).run();

    tx.insert(schema.dmMembers).values({
      dmChannelId,
      userId: callerId,
    }).run();

    tx.insert(schema.dmMembers).values({
      dmChannelId,
      userId: targetUser.id,
    }).run();
  });

  // Notify the target so their sidebar updates — same payload shape as POST /api/dm.
  const callerUser = db.select().from(schema.users).where(eq(schema.users.id, callerId)).get();
  const members = [callerUser, targetUser]
    .filter((u): u is NonNullable<typeof u> => u !== undefined)
    .map(u => sanitizeUser(u));

  const payload: DmChannel = {
    id: dmChannelId,
    ownerId: null,
    federatedId: federatedId ?? null,
    createdAt: now,
    members,
    lastMessage: null,
  };

  connectionManager.sendToUser(targetUser.id, {
    type: 'dm_channel_created',
    dmChannel: payload,
  });

  return dmChannelId;
}

/**
 * Shared core for the leave-DM and kick-DM paths.
 *
 * Performs the destructive half of removal (system message, member-row delete,
 * read_states cleanup, federation relay, dm_member_removed broadcast,
 * ownership transfer for self-leave, soft-delete on last-member-leave).
 *
 * Pre-validation (channel exists, not 1-on-1, target is a member, etc.) is the
 * caller's responsibility; this helper assumes a valid group DM and a valid
 * target. The caller is also responsible for any voice-room eviction and for
 * sending dm_channel_closed to the affected user.
 *
 * Branching rules:
 *   - Ownership transfer fires only when the actor is leaving themselves AND
 *     was the previous owner (kicks cannot orphan a group: the owner is still
 *     present, so there's nothing to transfer).
 *   - Last-member soft-delete fires only on self-leave (kicks are guaranteed
 *     to leave the owner behind, so the channel can never be empty after a
 *     kick).
 */
/**
 * Evicts a user from a DM channel's voice room (if they're in it), broadcasts the
 * voice_state_update, and tears down the room/call when it becomes empty.
 *
 * Shared by self-leave and owner-kick paths so call-state cleanup stays in lockstep.
 * No-op if the user isn't currently in this DM's voice room.
 */
function evictUserFromDmVoiceRoom(channelId: string, userId: string): void {
  const userRoom = connectionManager.getUserRoom(userId);
  if (userRoom && userRoom.roomId === channelId) {
    const left = connectionManager.leaveCurrentRoom(userId);
    if (left) {
      connectionManager.sendToDmMembers(channelId, {
        type: 'voice_state_update',
        channelId,
        userId,
        action: 'leave',
      });
      // Auto-end call if DM room is now empty
      const updatedRoom = connectionManager.getRoom(channelId);
      if (updatedRoom && updatedRoom.participants.size === 0) {
        connectionManager.destroyRoom(channelId);
        connectionManager.sendToDmMembers(channelId, {
          type: 'dm_call_ended',
          dmChannelId: channelId,
        });
      }
    }
    connectionManager.clearVoiceUserStatus(userId);
  }
}

/**
 * Transfers group-DM ownership from `previousOwnerId` to `newOwnerId`.
 *
 * Shared by the leave-path's auto-transfer (when an owner leaves a non-empty group)
 * and the manual `POST /api/dm/:id/transfer` endpoint. Performs:
 *
 *   1. Channel UPDATE (ownerId + ownerHomeUserId + ownerHomeInstance)
 *   2. owner_changed system-message INSERT (authored by `actorUserId`)
 *   3. appendMutationLog + queueOutboxEvent for the `ownership_transfer` federation event
 *
 * Steps 1–3 run inside a single `db.transaction(...)` for atomicity. Broadcasts
 * (`dm_owner_updated` and `dm_message_created`) are side-effects and run AFTER
 * the transaction commits.
 *
 * Caller responsibilities (NOT done here):
 *   - Validation (membership, 1-on-1 rejection, self-transfer rejection, etc.)
 *   - Voice-room eviction
 *   - Member-row deletion (the leave-path handles this separately)
 *
 * `actorUserId` controls the `userId` on the inserted system message — i.e., who
 * appears as having performed the change. In both current call sites the actor IS
 * the previous owner (the leaver, or the owner calling the transfer endpoint), so
 * it defaults to `previousOwnerId`. The option is parameterizable for future paths
 * that may transfer ownership on behalf of someone else (e.g., admin tooling).
 */
function transferGroupDmOwnership(
  channelId: string,
  previousOwnerId: string,
  newOwnerId: string,
  options?: { actorUserId?: string },
): void {
  const db = getDb();
  const actorUserId = options?.actorUserId ?? previousOwnerId;

  // Pre-flight: fetch the channel + user rows the helper needs.
  const dmChannel = db.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, channelId)).get();
  if (!dmChannel) {
    // Caller validates; defensive no-op.
    return;
  }

  const previousOwnerRow = db.select().from(schema.users).where(eq(schema.users.id, previousOwnerId)).get();
  const newOwnerRow = db.select().from(schema.users).where(eq(schema.users.id, newOwnerId)).get();
  const actorUserRow = actorUserId === previousOwnerId
    ? previousOwnerRow
    : db.select().from(schema.users).where(eq(schema.users.id, actorUserId)).get();

  const newOwnerBaseName = newOwnerRow?.username?.includes('@')
    ? newOwnerRow.username.split('@')[0]
    : (newOwnerRow?.username ?? 'Unknown');
  const newOwnerDisplayName = newOwnerRow?.displayName ?? newOwnerBaseName;

  // Federation targets must be computed BEFORE the channel update so we use the
  // current home-identity columns; membership doesn't change in a transfer, so a
  // post-transaction snapshot would also be valid, but pre-computing here keeps
  // the federation gate close to the data it depends on.
  let fedTargetOrigins: string[] | undefined;
  const federationActive = isFederationRelayEnabled() && !!dmChannel.federatedId;
  if (federationActive) {
    fedTargetOrigins = getGroupDmTargetOrigins(channelId);
  }

  const domainOrigin = isFederationRelayEnabled() ? getOurOrigin() : null;
  const newOwnerHomeUserId = newOwnerRow?.homeUserId || newOwnerId;
  const newOwnerHomeInstance = newOwnerRow?.homeInstance || domainOrigin || '';

  const ownerSysMsgId = generateSnowflake();
  const ownerNow = Date.now();
  const ownerSysContent = JSON.stringify({
    event: 'owner_changed',
    newOwnerId,
    newOwnerDisplayName,
  });

  const transferPayload: FederationRelayEvent | null = federationActive
    ? {
        eventType: 'ownership_transfer',
        dmChannelId: channelId,
        messageId: `ownership_transfer:${newOwnerId}:${ownerNow}`,
        federatedId: dmChannel.federatedId!,
        encryptionVersion: 0,
        timestamp: ownerNow,
        ownership: {
          newOwner: {
            homeUserId: newOwnerHomeUserId,
            homeInstance: newOwnerHomeInstance || (domainOrigin ?? ''),
          },
          previousOwner: {
            homeUserId: previousOwnerRow?.homeUserId || previousOwnerId,
            homeInstance: previousOwnerRow?.homeInstance || (domainOrigin ?? ''),
          },
        },
      }
    : null;

  // Atomic: channel UPDATE + system message INSERT + mutation log + outbox queue.
  db.transaction((tx) => {
    tx.update(schema.dmChannels)
      .set({
        ownerId: newOwnerId,
        ownerHomeUserId: newOwnerHomeUserId,
        ownerHomeInstance: newOwnerHomeInstance || null,
      })
      .where(eq(schema.dmChannels.id, channelId))
      .run();

    tx.insert(schema.dmMessages).values({
      id: ownerSysMsgId,
      dmChannelId: channelId,
      userId: actorUserId,
      content: ownerSysContent,
      type: 'system',
      createdAt: ownerNow,
    }).run();

    if (transferPayload) {
      appendMutationLog(
        transferPayload.messageId,
        channelId,
        'ownership_transfer',
        JSON.stringify(transferPayload),
      );
      queueOutboxEvent(
        transferPayload.messageId,
        channelId,
        'ownership_transfer',
        JSON.stringify(transferPayload),
        fedTargetOrigins,
      );
    }
  });

  // Snapshot the post-update member list for broadcasts (membership unchanged by transfer).
  const members = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channelId))
    .all();

  // Broadcast dm_owner_updated to local members.
  for (const member of members) {
    connectionManager.sendToUser(member.userId, {
      type: 'dm_owner_updated',
      dmChannelId: channelId,
      newOwnerId,
    });
  }

  // Broadcast the owner_changed system message to local members.
  for (const member of members) {
    connectionManager.sendToUser(member.userId, {
      type: 'dm_message_created',
      message: {
        id: ownerSysMsgId,
        dmChannelId: channelId,
        userId: actorUserId,
        content: ownerSysContent,
        type: 'system',
        createdAt: ownerNow,
        user: actorUserRow ? sanitizeUser(actorUserRow) : undefined,
        attachments: [],
        embeds: [],
        reactions: [],
      } as any,
    });
  }
}

function removeDmMember(
  channelId: string,
  actorUserId: string,
  targetUserId: string,
  reason: 'leave' | 'kick',
): void {
  const db = getDb();
  const isSelfLeave = actorUserId === targetUserId;

  const dmChannel = db.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, channelId)).get();
  if (!dmChannel) {
    // Should never happen — caller validates. Defensive no-op.
    return;
  }

  // Compute federation targets BEFORE member deletion so the removed user's peer is still included
  let fedTargetOrigins: string[] | undefined;
  if (isFederationRelayEnabled() && dmChannel.federatedId) {
    fedTargetOrigins = getGroupDmTargetOrigins(channelId);
  }

  const targetUserRow = db.select().from(schema.users).where(eq(schema.users.id, targetUserId)).get();
  const actorUserRow = isSelfLeave
    ? targetUserRow
    : db.select().from(schema.users).where(eq(schema.users.id, actorUserId)).get();

  const targetBaseName = targetUserRow?.username?.includes('@')
    ? targetUserRow.username.split('@')[0]
    : (targetUserRow?.username ?? 'Unknown');

  // Insert + broadcast member_removed system message (still a member at this point)
  const sysMsgId = generateSnowflake();
  const sysNow = Date.now();
  const sysContent = JSON.stringify({
    event: 'member_removed',
    targetUserId,
    targetDisplayName: targetUserRow?.displayName ?? targetBaseName,
    reason,
  });

  db.insert(schema.dmMessages).values({
    id: sysMsgId,
    dmChannelId: channelId,
    userId: actorUserId,
    content: sysContent,
    type: 'system',
    createdAt: sysNow,
  }).run();

  connectionManager.sendToDmMembers(channelId, {
    type: 'dm_message_created',
    message: {
      id: sysMsgId,
      dmChannelId: channelId,
      userId: actorUserId,
      content: sysContent,
      type: 'system',
      createdAt: sysNow,
      user: actorUserRow ? sanitizeUser(actorUserRow) : undefined,
      attachments: [],
      embeds: [],
      reactions: [],
    } as any,
  });

  // Delete dm_members row for the target
  db.delete(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, channelId),
      eq(schema.dmMembers.userId, targetUserId),
    ))
    .run();

  // Clean up read_states for the removed user
  db.delete(schema.readStates).where(and(
    eq(schema.readStates.userId, targetUserId),
    eq(schema.readStates.channelId, channelId),
  )).run();

  // Federation: relay member_remove event with the reason
  if (isFederationRelayEnabled() && dmChannel.federatedId) {
    const domainOrigin = getOurOrigin();

    const memberRemovePayload: FederationRelayEvent = {
      eventType: 'member_remove',
      dmChannelId: channelId,
      messageId: `member_remove:${targetUserId}:${Date.now()}`,
      federatedId: dmChannel.federatedId,
      encryptionVersion: 0,
      timestamp: Date.now(),
      membership: {
        user: {
          homeUserId: targetUserRow?.homeUserId || targetUserId,
          homeInstance: targetUserRow?.homeInstance || domainOrigin,
        },
        removedBy: {
          homeUserId: actorUserRow?.homeUserId || actorUserId,
          homeInstance: actorUserRow?.homeInstance || domainOrigin,
        },
        reason,
      },
    };

    appendMutationLog(
      memberRemovePayload.messageId,
      channelId,
      'member_remove',
      JSON.stringify(memberRemovePayload),
    );
    queueOutboxEvent(
      memberRemovePayload.messageId,
      channelId,
      'member_remove',
      JSON.stringify(memberRemovePayload),
      fedTargetOrigins,
    );
  }

  // Check remaining members
  const remainingMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channelId))
    .all();

  if (remainingMembers.length > 0) {
    // Ownership transfer only fires on self-leave when the leaver was the owner.
    // Kicks cannot orphan a group: the owner is still in the channel.
    if (isSelfLeave && dmChannel.ownerId === actorUserId) {
      const nextOwner = remainingMembers[0];
      if (nextOwner) {
        transferGroupDmOwnership(channelId, actorUserId, nextOwner.userId, { actorUserId });
      }
    }

    // Broadcast dm_member_removed to remaining members
    for (const member of remainingMembers) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_member_removed',
        dmChannelId: channelId,
        userId: targetUserId,
      });
    }
  } else if (isSelfLeave) {
    // Last member left — soft-delete for deferred GC (24h grace period).
    // Only reachable via self-leave; kicks always leave the owner behind.
    db.update(schema.dmChannels)
      .set({ deletedAt: Date.now() })
      .where(eq(schema.dmChannels.id, channelId))
      .run();
    console.log(`[dm] Group DM ${channelId} has no remaining members, soft-deleted for GC`);
  }
}

export async function dmRoutes(app: FastifyInstance): Promise<void> {
  // Centralized auth for all DM routes
  app.addHook('preHandler', authenticate);

  // GET /api/dm - List user's DM channels
  app.get('/api/dm', async (request, reply) => {
    const db = getDb();

    const memberships = db.select()
      .from(schema.dmMembers)
      .where(and(
        eq(schema.dmMembers.userId, request.userId),
        eq(schema.dmMembers.closed, 0),
      ))
      .all();

    if (memberships.length === 0) {
      return reply.code(200).send([]);
    }

    const dmChannelIds = memberships.map(m => m.dmChannelId);

    // Batch fetch all DM channels (exclude soft-deleted)
    const channelRows = db.select().from(schema.dmChannels)
      .where(and(inArray(schema.dmChannels.id, dmChannelIds), isNull(schema.dmChannels.deletedAt))).all();
    const channelMap = new Map(channelRows.map(c => [c.id, c]));

    // Batch fetch all DM members
    const allMemberRows = db.select().from(schema.dmMembers)
      .where(inArray(schema.dmMembers.dmChannelId, dmChannelIds)).all();
    const membersByChannel = new Map<string, string[]>();
    for (const m of allMemberRows) {
      if (!membersByChannel.has(m.dmChannelId)) membersByChannel.set(m.dmChannelId, []);
      membersByChannel.get(m.dmChannelId)!.push(m.userId);
    }

    // Batch fetch all unique users
    const allUserIds = [...new Set(allMemberRows.map(m => m.userId))];
    const userRows = allUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, allUserIds)).all()
      : [];
    const userMap = new Map(userRows.map(u => [u.id, u]));

    // Batch fetch last message per DM channel:
    // Get the max created_at per channel, then fetch matching messages
    const maxTimestamps = db.select({
      dmChannelId: schema.dmMessages.dmChannelId,
      maxCreatedAt: sql<number>`MAX(${schema.dmMessages.createdAt})`.as('max_created_at'),
    })
      .from(schema.dmMessages)
      .where(inArray(schema.dmMessages.dmChannelId, dmChannelIds))
      .groupBy(schema.dmMessages.dmChannelId)
      .all();

    const lastMessageMap = new Map<string, { id: string; dmChannelId: string; userId: string; content: string | null; createdAt: number; type: 'user' | 'system' }>();
    if (maxTimestamps.length > 0) {
      // Build conditions to fetch the actual message rows matching max timestamps
      const conditions = maxTimestamps.map(t =>
        and(eq(schema.dmMessages.dmChannelId, t.dmChannelId), eq(schema.dmMessages.createdAt, t.maxCreatedAt!))
      );
      const lastMessages = db.select()
        .from(schema.dmMessages)
        .where(or(...conditions))
        .all();
      for (const m of lastMessages) {
        // In case of ties, keep the first one per channel
        if (!lastMessageMap.has(m.dmChannelId)) {
          lastMessageMap.set(m.dmChannelId, {
            id: m.id, dmChannelId: m.dmChannelId, userId: m.userId,
            content: m.content, createdAt: m.createdAt,
            type: m.type === 'system' ? 'system' : 'user',
          });
        }
      }
    }

    // Batch fetch attachments for last messages
    const lastMsgIds = [...lastMessageMap.values()].map(m => m.id);
    const lastMsgAttachments = lastMsgIds.length > 0
      ? db.select({
          dmMessageId: schema.attachments.dmMessageId,
          type: schema.attachments.mimetype,
          filename: schema.attachments.originalName,
        }).from(schema.attachments).where(inArray(schema.attachments.dmMessageId, lastMsgIds)).all()
      : [];
    const lastMsgAttachmentMap = new Map<string, Array<{ type: string; filename: string }>>();
    for (const a of lastMsgAttachments) {
      if (!a.dmMessageId) continue;
      const arr = lastMsgAttachmentMap.get(a.dmMessageId) ?? [];
      arr.push({ type: a.type, filename: a.filename });
      lastMsgAttachmentMap.set(a.dmMessageId, arr);
    }

    // Assemble results
    const dmChannels: DmChannel[] = [];
    for (const channelId of dmChannelIds) {
      const channel = channelMap.get(channelId);
      if (!channel) continue;

      const memberIds = membersByChannel.get(channelId) ?? [];
      const members = memberIds
        .map(id => userMap.get(id))
        .filter((u): u is NonNullable<typeof u> => u !== undefined)
        .map(u => sanitizeUser(u));

      const lastMsg = lastMessageMap.get(channelId) ?? null;

      dmChannels.push({
        id: channel.id,
        ownerId: channel.ownerId ?? null,
        createdAt: channel.createdAt,
        members,
        lastMessage: lastMsg ? {
          id: lastMsg.id,
          dmChannelId: lastMsg.dmChannelId,
          userId: lastMsg.userId,
          content: lastMsg.content,
          createdAt: lastMsg.createdAt,
          type: lastMsg.type,
          attachments: lastMsgAttachmentMap.get(lastMsg.id) ?? [],
        } : null,
      });
    }

    // Sort by last message timestamp (newest first)
    dmChannels.sort((a, b) => {
      const aTime = a.lastMessage?.createdAt ?? a.createdAt;
      const bTime = b.lastMessage?.createdAt ?? b.createdAt;
      return bTime - aTime;
    });

    return reply.code(200).send(dmChannels);
  });

  // POST /api/dm - Create or get existing DM channel
  app.post<{ Body: CreateDmRequest }>('/api/dm', async (request, reply) => {
    const { userId, homeUserId, homeInstance } = request.body;

    const db = getDb();
    let targetUser: typeof schema.users.$inferSelect | undefined;

    if (homeUserId && homeInstance) {
      // Federated identity: resolve or create a replicated user stub
      targetUser = resolveOrCreateReplicatedUser(homeUserId, homeInstance, db) ?? undefined;
    } else if (userId && typeof userId === 'string') {
      // Local ID: direct lookup (existing behavior)
      targetUser = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    } else {
      return reply.code(400).send({ error: 'userId or (homeUserId + homeInstance) is required', statusCode: 400 });
    }

    if (!targetUser) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    const targetUserId = targetUser.id;

    if (targetUserId === request.userId) {
      return reply.code(400).send({ error: 'Cannot create DM with yourself', statusCode: 400 });
    }

    // Check if DM channel already exists between these two users
    // (both have membership rows, regardless of closed state)
    const myDms = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.userId, request.userId))
      .all();

    for (const myDm of myDms) {
      const otherMember = db.select()
        .from(schema.dmMembers)
        .where(and(
          eq(schema.dmMembers.dmChannelId, myDm.dmChannelId),
          eq(schema.dmMembers.userId, targetUserId),
        ))
        .get();

      if (otherMember) {
        // Only match 1-on-1 DMs (exactly 2 members). Skip group DMs that
        // happen to include the target user to avoid returning the wrong channel.
        const memberCount = db.select()
          .from(schema.dmMembers)
          .where(eq(schema.dmMembers.dmChannelId, myDm.dmChannelId))
          .all()
          .length;
        if (memberCount !== 2) continue;

        // DM channel already exists between these users (exclude soft-deleted)
        const dmChannel = db.select()
          .from(schema.dmChannels)
          .where(and(eq(schema.dmChannels.id, myDm.dmChannelId), isNull(schema.dmChannels.deletedAt)))
          .get();

        if (!dmChannel) continue;

        // Reopen if the requesting user had closed it
        if (myDm.closed === 1) {
          db.update(schema.dmMembers)
            .set({ closed: 0 })
            .where(and(
              eq(schema.dmMembers.dmChannelId, myDm.dmChannelId),
              eq(schema.dmMembers.userId, request.userId),
            ))
            .run();

          // Relay reopen to federated peers
          queueDmCloseRelay(myDm.dmChannelId, request.userId, 'dm_reopen');
        }

        const dmMemberRows = db.select()
          .from(schema.dmMembers)
          .where(eq(schema.dmMembers.dmChannelId, myDm.dmChannelId))
          .all();

        const memberUserIds = dmMemberRows.map(m => m.userId);
        const users = db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all();

        // Fetch actual last message
        const lastMsgRows = db.select()
          .from(schema.dmMessages)
          .where(eq(schema.dmMessages.dmChannelId, myDm.dmChannelId))
          .orderBy(desc(schema.dmMessages.createdAt))
          .limit(1)
          .all();
        const lastMsg = lastMsgRows[0] ?? null;

        const result: DmChannel = {
          id: dmChannel.id,
          ownerId: dmChannel.ownerId ?? null,
          federatedId: dmChannel.federatedId ?? null,
          createdAt: dmChannel.createdAt,
          members: users.map(u => sanitizeUser(u)),
          lastMessage: lastMsg ? {
            id: lastMsg.id,
            dmChannelId: lastMsg.dmChannelId,
            userId: lastMsg.userId,
            content: lastMsg.content,
            createdAt: lastMsg.createdAt,
            type: lastMsg.type === 'system' ? 'system' : 'user',
          } : null,
        };

        return reply.code(200).send(result);
      }
    }

    // Create new DM channel with both members atomically
    const dmChannelId = generateSnowflake();
    const now = Date.now();

    // Compute deterministic federatedId for federated 1-on-1 DMs so that the
    // S2S relay can find this channel when the reply arrives, preventing duplicates.
    let federatedId: string | null = null;
    if (isFederationRelayEnabled()) {
      const callerUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
      const callerHomeUserId = callerUser?.homeUserId || request.userId;
      const targetHomeUserId = targetUser.homeUserId || targetUser.id;
      const callerHomeInstance = callerUser?.homeInstance || null;
      const targetHomeInstance = targetUser.homeInstance || null;

      // If either user is federated, this DM needs a federatedId for S2S relay matching
      if (callerHomeInstance || targetHomeInstance) {
        federatedId = computeFederatedId(callerHomeUserId, targetHomeUserId);
      }
    }

    db.transaction((tx) => {
      tx.insert(schema.dmChannels).values({
        id: dmChannelId,
        ownerId: null,
        federatedId,
        createdAt: now,
      }).run();

      tx.insert(schema.dmMembers).values({
        dmChannelId,
        userId: request.userId,
      }).run();

      tx.insert(schema.dmMembers).values({
        dmChannelId,
        userId: targetUserId,
      }).run();
    });

    const currentUserRow = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    const members = [currentUserRow, targetUser]
      .filter((u): u is NonNullable<typeof u> => u !== undefined)
      .map(u => sanitizeUser(u));

    const result: DmChannel = {
      id: dmChannelId,
      ownerId: null,
      federatedId: federatedId ?? null,
      createdAt: now,
      members,
      lastMessage: null,
    };

    // Broadcast dm_channel_created to the other user so their sidebar updates
    connectionManager.sendToUser(targetUserId, {
      type: 'dm_channel_created',
      dmChannel: result,
    });

    return reply.code(201).send(result);
  });

  // POST /api/dm/group - Create a new group DM with multiple members
  app.post<{ Body: CreateGroupDmRequest }>('/api/dm/group', async (request, reply) => {
    const { users: userIdentities, fromDmChannelId } = request.body;

    // Validate input is a non-empty array of at least 2 identity objects
    if (!Array.isArray(userIdentities) || userIdentities.length < 2) {
      return reply.code(400).send({ error: 'users must contain at least 2 entries', statusCode: 400 });
    }
    if (userIdentities.some(u => !u || typeof u.id !== 'string' || !u.id)) {
      return reply.code(400).send({ error: 'All entries must have a non-empty id', statusCode: 400 });
    }

    // Total members (caller + users) capped at 10
    const totalMembers = 1 + userIdentities.length;
    if (totalMembers > 10) {
      return reply.code(400).send({ error: `Group DMs are limited to 10 members (requested ${totalMembers})`, statusCode: 400 });
    }

    const db = getDb();

    // Resolve each identity to a local user row
    const targetUsers: Array<typeof schema.users.$inferSelect> = [];
    for (const identity of userIdentities) {
      let localUser: typeof schema.users.$inferSelect | undefined;

      if (identity.homeUserId && identity.homeInstance) {
        // Federated user — resolve via homeUserId, creating a replicated stub if needed
        localUser = resolveOrCreateReplicatedUser(identity.homeUserId, identity.homeInstance, db) ?? undefined;
      } else {
        // Local user — direct ID lookup
        localUser = db.select().from(schema.users).where(
          and(eq(schema.users.id, identity.id), eq(schema.users.isDeleted, 0)),
        ).get();

        // Fallback: if direct ID lookup fails, try homeUserId resolution
        // (handles case where identity.id is a remote snowflake but homeUserId wasn't provided)
        if (!localUser) {
          localUser = resolveLocalUser(identity.id, db);
        }
      }

      if (!localUser) {
        return reply.code(404).send({ error: 'One or more users not found', statusCode: 404 });
      }
      if (localUser.isDeleted) {
        return reply.code(404).send({ error: 'One or more users not found', statusCode: 404 });
      }

      targetUsers.push(localUser);
    }

    // Dedup: check no resolved user appears twice
    const resolvedIds = new Set(targetUsers.map(u => u.id));
    if (resolvedIds.size !== targetUsers.length) {
      return reply.code(400).send({ error: 'Duplicate users after identity resolution', statusCode: 400 });
    }

    // Caller cannot include themselves
    if (targetUsers.some(u => u.id === request.userId)) {
      return reply.code(400).send({ error: 'Do not include yourself — you are added automatically', statusCode: 400 });
    }

    // When converting a 1-on-1 DM to a group, existing DM members are exempt
    // from the friendship check (DMs don't require friendship).
    const exemptUserIds = new Set<string>();
    if (fromDmChannelId) {
      const sourceDm = db.select().from(schema.dmChannels).where(
        and(eq(schema.dmChannels.id, fromDmChannelId), isNull(schema.dmChannels.deletedAt)),
      ).get();
      if (sourceDm && !sourceDm.ownerId) {
        // Only exempt members from 1-on-1 DMs (ownerId is null)
        if (isDmMember(fromDmChannelId, request.userId)) {
          const members = db.select().from(schema.dmMembers)
            .where(eq(schema.dmMembers.dmChannelId, fromDmChannelId)).all();
          for (const m of members) {
            exemptUserIds.add(m.userId);
          }
        }
      }
    }

    // Validate all target users are friends with the caller (exempt existing DM members)
    for (const targetUser of targetUsers) {
      if (exemptUserIds.has(targetUser.id)) continue;

      const friendship = db.select().from(schema.friends).where(
        or(
          and(eq(schema.friends.userId, request.userId), eq(schema.friends.friendId, targetUser.id)),
          and(eq(schema.friends.userId, targetUser.id), eq(schema.friends.friendId, request.userId)),
        ),
      ).get();

      if (!friendship) {
        return reply.code(403).send({ error: `You can only add friends to group DMs. ${targetUser.displayName ?? targetUser.username} is not your friend.`, statusCode: 403 });
      }
    }

    // Create group DM channel + members in a single transaction
    const dmChannelId = generateSnowflake();
    const now = Date.now();

    db.transaction((tx) => {
      tx.insert(schema.dmChannels).values({
        id: dmChannelId,
        ownerId: request.userId,
        createdAt: now,
      }).run();

      tx.insert(schema.dmMembers).values({
        dmChannelId,
        userId: request.userId,
      }).run();

      for (const targetUser of targetUsers) {
        tx.insert(schema.dmMembers).values({
          dmChannelId,
          userId: targetUser.id,
        }).run();
      }
    });

    // Fetch caller's user row once — used for response, federation, and relay
    const callerUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();

    // Federation: assign federatedId if any member is from a remote instance
    let federatedId: string | null = null;
    if (isFederationRelayEnabled()) {
      const domainOrigin = getOurOrigin();
      const allUsers = [callerUser, ...targetUsers].filter((u): u is NonNullable<typeof u> => u !== undefined);
      const hasRemote = allUsers.some(u => u.homeInstance && u.homeInstance !== domainOrigin);

      if (hasRemote) {
        federatedId = computeFederatedId();
        db.update(schema.dmChannels)
          .set({
            federatedId,
            ownerHomeUserId: callerUser?.homeUserId || request.userId,
            ownerHomeInstance: callerUser?.homeInstance || domainOrigin,
          })
          .where(eq(schema.dmChannels.id, dmChannelId))
          .run();
      }
    }

    // Build response
    const allMembers = [callerUser, ...targetUsers]
      .filter((u): u is NonNullable<typeof u> => u !== undefined)
      .map(u => sanitizeUser(u));

    const result: DmChannel = {
      id: dmChannelId,
      ownerId: request.userId,
      federatedId: federatedId ?? null,
      createdAt: now,
      members: allMembers,
      lastMessage: null,
    };

    // Broadcast dm_channel_created only to LOCAL members.
    // Remote members will receive the channel via federation relay → bootstrap
    // on their home instance, preventing duplicate channels in their sidebar.
    const domainOriginForBroadcast = isFederationRelayEnabled() ? getOurOrigin() : null;
    const isLocalMember = (u: { homeInstance?: string | null }) =>
      !u.homeInstance || !domainOriginForBroadcast ||
      u.homeInstance === domainOriginForBroadcast ||
      `https://${u.homeInstance}` === domainOriginForBroadcast;

    for (const member of allMembers) {
      if (!isLocalMember(member)) continue;
      connectionManager.sendToUser(member.id, {
        type: 'dm_channel_created',
        dmChannel: result,
      });
    }

    // Insert system messages (DB) for all members, but only broadcast to local members.
    // Remote instances create their own system messages via federation event handlers.
    for (const targetUser of targetUsers) {
      if (!targetUser) continue;
      const baseName = targetUser.username.includes('@') ? targetUser.username.split('@')[0] : targetUser.username;
      const sysMsg = {
        id: generateSnowflake(),
        dmChannelId: dmChannelId,
        userId: request.userId,
        content: JSON.stringify({
          event: 'member_added',
          targetUserId: targetUser.id,
          targetDisplayName: targetUser.displayName ?? baseName,
        }),
        type: 'system' as const,
        createdAt: now,
        user: callerUser ? sanitizeUser(callerUser) : undefined,
        attachments: [],
        embeds: [],
        reactions: [],
      };

      db.insert(schema.dmMessages).values({
        id: sysMsg.id,
        dmChannelId: sysMsg.dmChannelId,
        userId: sysMsg.userId,
        content: sysMsg.content,
        type: 'system',
        createdAt: sysMsg.createdAt,
      }).run();

      // Only broadcast to local members — remote instances handle their own
      for (const member of allMembers) {
        if (!isLocalMember(member)) continue;
        connectionManager.sendToUser(member.id, {
          type: 'dm_message_created',
          message: sysMsg as any,
        });
      }
    }

    // Federation: relay member_add for each remote member
    if (isFederationRelayEnabled() && federatedId) {
      const domainOrigin = getOurOrigin();
      const allParticipants = getDmParticipants(dmChannelId);

      // Re-fetch the channel row so the bootstrap payload carries the
      // current name/icon/metadataUpdatedAt. On a freshly-created group
      // these are null/null/0, but we read them rather than hard-code
      // so future producer paths (or test mutations between create and
      // relay) stay correct without touching this site.
      const channelRow = db.select().from(schema.dmChannels)
        .where(eq(schema.dmChannels.id, dmChannelId)).get();
      const wireIcon = normalizeIconForWire(channelRow?.icon ?? null, domainOrigin);

      for (const targetUser of targetUsers) {
        if (!targetUser.homeInstance || targetUser.homeInstance === domainOrigin) continue;

        const memberAddPayload: FederationRelayEvent = {
          eventType: 'member_add',
          dmChannelId,
          messageId: `member_add:${targetUser.id}:${Date.now()}`,
          federatedId,
          encryptionVersion: 0,
          timestamp: Date.now(),
          membership: {
            user: {
              homeUserId: targetUser.homeUserId || targetUser.id,
              homeInstance: targetUser.homeInstance || domainOrigin,
            },
            addedBy: {
              homeUserId: callerUser?.homeUserId || request.userId,
              homeInstance: callerUser?.homeInstance || domainOrigin,
            },
          },
          group: {
            owner: {
              homeUserId: callerUser?.homeUserId || request.userId,
              homeInstance: callerUser?.homeInstance || domainOrigin,
            },
            members: allParticipants,
            name: channelRow?.name ?? null,
            icon: wireIcon,
            metadataUpdatedAt: channelRow?.metadataUpdatedAt ?? 0,
          },
        };

        const targetOrigins = getGroupDmTargetOrigins(dmChannelId);
        let finalTargets = targetOrigins;
        // Normalize homeInstance to full URL to match peer origin format
        const targetHomeOrigin = targetUser.homeInstance?.startsWith('http') ? targetUser.homeInstance : `https://${targetUser.homeInstance}`;
        if (finalTargets && targetHomeOrigin !== domainOrigin && !finalTargets.includes(targetHomeOrigin)) {
          finalTargets = [...finalTargets, targetHomeOrigin];
        }

        appendMutationLog(
          memberAddPayload.messageId,
          dmChannelId,
          'member_add',
          JSON.stringify(memberAddPayload),
        );
        queueOutboxEvent(
          memberAddPayload.messageId,
          dmChannelId,
          'member_add',
          JSON.stringify(memberAddPayload),
          finalTargets,
        );
      }
    }

    return reply.code(201).send(result);
  });

  // PATCH /api/dm/:id — Update group DM metadata (name + icon). Owner-only.
  // Body: { name?: string | null, icon?: string | null }
  // - name: trimmed; empty → cleared (null); otherwise length must be in
  //   [GROUP_DM_NAME_MIN_LENGTH, GROUP_DM_NAME_MAX_LENGTH].
  // - icon: null/empty → cleared; bare filename → must be an attachment
  //   uploaded by the caller, image/* mimetype, ≤ GROUP_DM_ICON_MAX_BYTES;
  //   absolute http(s) URL → accepted as-is (federated rebroadcast path).
  app.patch<{ Params: { id: string }; Body: { name?: string | null; icon?: string | null } }>('/api/dm/:id', async (request, reply) => {
    const { id } = request.params;
    const body = request.body ?? {};
    const db = getDb();

    // Fetch channel
    const dmChannel = db.select()
      .from(schema.dmChannels)
      .where(and(eq(schema.dmChannels.id, id), isNull(schema.dmChannels.deletedAt)))
      .get();
    if (!dmChannel) {
      return reply.code(404).send({ error: 'DM channel not found', statusCode: 404 });
    }

    // 1-on-1 DMs (ownerId=NULL) cannot have metadata
    if (!dmChannel.ownerId) {
      return reply.code(400).send({ error: 'Cannot update metadata on a 1-on-1 DM', statusCode: 400 });
    }

    // Caller must be a member
    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    // Caller must be the owner
    if (dmChannel.ownerId !== request.userId) {
      return reply.code(403).send({ error: 'Only the group owner can update metadata', statusCode: 403 });
    }

    const nameProvided = Object.prototype.hasOwnProperty.call(body, 'name');
    const iconProvided = Object.prototype.hasOwnProperty.call(body, 'icon');

    if (!nameProvided && !iconProvided) {
      // No fields to update — return the channel unchanged.
      return reply.code(200).send({ id: dmChannel.id, name: dmChannel.name, icon: dmChannel.icon, metadataUpdatedAt: dmChannel.metadataUpdatedAt });
    }

    const oldName = dmChannel.name ?? null;
    const oldIcon = dmChannel.icon ?? null;

    // ---- Resolve next name (with no-op short-circuit) ----
    let nextName: string | null = oldName;
    let nameChanged = false;
    if (nameProvided) {
      const raw = body.name;
      let candidate: string | null;
      if (raw === null || raw === undefined) {
        candidate = null;
      } else if (typeof raw !== 'string') {
        return reply.code(400).send({ error: 'name must be a string or null', statusCode: 400 });
      } else {
        const trimmed = raw.trim();
        candidate = trimmed.length === 0 ? null : trimmed;
      }
      // Validate length only if the value is actually changing — a no-op repeat
      // of the stored value (even one that wouldn't pass current validation,
      // e.g. legacy data) must not 400.
      if (candidate !== oldName) {
        if (candidate !== null) {
          if (candidate.length < GROUP_DM_NAME_MIN_LENGTH || candidate.length > GROUP_DM_NAME_MAX_LENGTH) {
            return reply.code(400).send({
              error: `Group DM name must be between ${GROUP_DM_NAME_MIN_LENGTH} and ${GROUP_DM_NAME_MAX_LENGTH} characters`,
              statusCode: 400,
            });
          }
        }
        nextName = candidate;
        nameChanged = true;
      }
    }

    // ---- Resolve next icon (with no-op short-circuit) ----
    let nextIcon: string | null = oldIcon;
    let iconChanged = false;
    if (iconProvided) {
      const raw = body.icon;
      let candidate: string | null;
      if (raw === null || raw === undefined) {
        candidate = null;
      } else if (typeof raw !== 'string') {
        return reply.code(400).send({ error: 'icon must be a string or null', statusCode: 400 });
      } else {
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          candidate = null;
        } else if (!isValidAssetUrl(trimmed)) {
          return reply.code(400).send({ error: 'Invalid icon URL', statusCode: 400 });
        } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          candidate = trimmed;
        } else {
          // Bare filename or `/api/uploads/<filename>` — normalize to bare filename.
          candidate = trimmed.startsWith('/api/uploads/') ? trimmed.slice('/api/uploads/'.length) : trimmed;
        }
      }
      // Only validate attachment ownership/mimetype/size when the icon is
      // actually changing AND the new value is a local filename (not an
      // absolute URL or null clear).
      if (candidate !== oldIcon) {
        if (candidate !== null
            && !candidate.startsWith('http://')
            && !candidate.startsWith('https://')) {
          const attachment = db.select()
            .from(schema.attachments)
            .where(eq(schema.attachments.filename, candidate))
            .get();

          if (!attachment) {
            return reply.code(400).send({ error: 'Icon attachment not found', statusCode: 400 });
          }
          if (attachment.uploaderId !== request.userId) {
            return reply.code(403).send({ error: 'You do not own this icon attachment', statusCode: 403 });
          }
          if (!attachment.mimetype.startsWith(GROUP_DM_ICON_MIME_PREFIX)) {
            return reply.code(400).send({ error: 'Icon must be an image', statusCode: 400 });
          }
          if (attachment.size > GROUP_DM_ICON_MAX_BYTES) {
            return reply.code(400).send({
              error: `Icon must be smaller than ${Math.floor(GROUP_DM_ICON_MAX_BYTES / (1024 * 1024))} MB`,
              statusCode: 400,
            });
          }
        }
        nextIcon = candidate;
        iconChanged = true;
      }
    }

    // ---- No-op short-circuit ----
    if (!nameChanged && !iconChanged) {
      return reply.code(200).send({
        id: dmChannel.id,
        name: dmChannel.name,
        icon: dmChannel.icon,
        metadataUpdatedAt: dmChannel.metadataUpdatedAt,
      });
    }

    // Caller user row — needed for federation actor identity
    const callerUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();

    // Single eventMessageId so name/icon system messages share a federation correlation root.
    const eventMessageId = generateSnowflake();
    const sysMessageRows: Array<{
      id: string;
      sourceMessageId: string;
      content: string;
    }> = [];

    // ---- Transaction: persist channel update + system message rows ----
    let metadataUpdatedAt = 0;
    db.transaction((tx) => {
      metadataUpdatedAt = Date.now();
      tx.update(schema.dmChannels)
        .set({ name: nextName, icon: nextIcon, metadataUpdatedAt })
        .where(eq(schema.dmChannels.id, id))
        .run();

      if (nameChanged) {
        const sysId = generateSnowflake();
        const content = JSON.stringify({ event: 'name_changed', oldName, newName: nextName });
        tx.insert(schema.dmMessages).values({
          id: sysId,
          dmChannelId: id,
          userId: request.userId,
          content,
          type: 'system',
          sourceMessageId: `${eventMessageId}:name`,
          createdAt: metadataUpdatedAt,
        }).run();
        sysMessageRows.push({ id: sysId, sourceMessageId: `${eventMessageId}:name`, content });
      }

      if (iconChanged) {
        const sysId = generateSnowflake();
        const content = JSON.stringify({ event: 'icon_changed' });
        tx.insert(schema.dmMessages).values({
          id: sysId,
          dmChannelId: id,
          userId: request.userId,
          content,
          type: 'system',
          sourceMessageId: `${eventMessageId}:icon`,
          createdAt: metadataUpdatedAt,
        }).run();
        sysMessageRows.push({ id: sysId, sourceMessageId: `${eventMessageId}:icon`, content });
      }
    });

    // ---- Broadcast channel update to local members ----
    connectionManager.sendToDmMembers(id, {
      type: 'dm_channel_updated',
      dmChannelId: id,
      name: nextName,
      icon: nextIcon,
    });

    // ---- Broadcast each new system message ----
    const sanitizedActor = callerUser ? sanitizeUser(callerUser) : undefined;
    for (const sys of sysMessageRows) {
      connectionManager.sendToDmMembers(id, {
        type: 'dm_message_created',
        message: {
          id: sys.id,
          dmChannelId: id,
          userId: request.userId,
          content: sys.content,
          type: 'system',
          createdAt: metadataUpdatedAt,
          user: sanitizedActor,
          attachments: [],
          embeds: [],
          reactions: [],
        } as DmMessageWithUser,
      });
    }

    // ---- Federation relay ----
    if (isFederationRelayEnabled()) {
      const domainOrigin = getOurOrigin();
      queueGroupMetadataRelay(id, {
        name: nextName,
        icon: nextIcon,
        metadataUpdatedAt,
        actor: {
          userId: request.userId,
          homeUserId: callerUser?.homeUserId ?? request.userId,
          homeInstance: callerUser?.homeInstance ?? domainOrigin,
        },
      });
    }

    // ---- Old icon cleanup (mirror users.ts:463-466 precedent) ----
    if (iconChanged && oldIcon && !oldIcon.startsWith('http')) {
      deleteUploadFile(oldIcon);
      deleteAttachmentByFilename(oldIcon);
    }
    // Clean up the attachment record for the newly-set icon — the file is
    // now referenced via dm_channels.icon (protected by the storage janitor),
    // so the standalone attachment row is unnecessary. Mirrors users.ts:473.
    if (iconChanged && nextIcon && !nextIcon.startsWith('http')) {
      deleteAttachmentByFilename(nextIcon);
    }

    return reply.code(200).send({
      id,
      name: nextName,
      icon: nextIcon,
      metadataUpdatedAt,
    });
  });

  // DELETE /api/dm/:id - Close (hide) a DM channel for the requesting user
  app.delete<{ Params: { id: string } }>('/api/dm/:id', async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    // Verify the user is a member of this DM channel
    const membership = db.select()
      .from(schema.dmMembers)
      .where(and(
        eq(schema.dmMembers.dmChannelId, id),
        eq(schema.dmMembers.userId, request.userId),
      ))
      .get();

    if (!membership) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    // Soft close: set closed flag (preserves membership for future message delivery)
    db.update(schema.dmMembers)
      .set({ closed: 1 })
      .where(and(
        eq(schema.dmMembers.dmChannelId, id),
        eq(schema.dmMembers.userId, request.userId),
      ))
      .run();

    // Broadcast dm_channel_closed to self for multi-tab sync
    connectionManager.sendToUser(request.userId, {
      type: 'dm_channel_closed',
      dmChannelId: id,
    });

    // Relay close to federated peers
    queueDmCloseRelay(id, request.userId, 'dm_close');

    return reply.code(200).send({ success: true });
  });

  // POST /api/dm/:id/members - Add a user to an existing DM channel (group DM upgrade)
  app.post<{ Params: { id: string }; Body: AddDmMemberRequest }>('/api/dm/:id/members', async (request, reply) => {
    const { id } = request.params;
    const { userId: targetUserIdRaw, homeUserId, homeInstance } = request.body;

    const db = getDb();
    let targetUser: typeof schema.users.$inferSelect | undefined;

    if (homeUserId && homeInstance) {
      // Federated identity: resolve or create a replicated user stub
      targetUser = resolveOrCreateReplicatedUser(homeUserId, homeInstance, db) ?? undefined;
    } else if (targetUserIdRaw && typeof targetUserIdRaw === 'string') {
      // Local ID: direct lookup (existing behavior)
      targetUser = db.select().from(schema.users).where(eq(schema.users.id, targetUserIdRaw)).get();
    } else {
      return reply.code(400).send({ error: 'userId or (homeUserId + homeInstance) is required', statusCode: 400 });
    }

    if (!targetUser) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    const targetUserId = targetUser.id;

    // Validate caller is a member
    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    // Fetch channel and enforce type + ownership constraints
    let dmChannel = db.select().from(schema.dmChannels).where(and(eq(schema.dmChannels.id, id), isNull(schema.dmChannels.deletedAt))).get();
    if (!dmChannel) {
      return reply.code(404).send({ error: 'DM channel not found', statusCode: 404 });
    }
    // 1-on-1 DMs (ownerId=NULL) are immutable — cannot add members
    if (!dmChannel.ownerId) {
      return reply.code(400).send({ error: 'Cannot add members to a 1-on-1 DM. Use POST /api/dm/group to create a group.', statusCode: 400 });
    }
    // Any group DM member can add friends (not just the owner)

    // Validate the adder and target are friends
    const friendship = db.select().from(schema.friends).where(
      or(
        and(eq(schema.friends.userId, request.userId), eq(schema.friends.friendId, targetUserId)),
        and(eq(schema.friends.userId, targetUserId), eq(schema.friends.friendId, request.userId)),
      ),
    ).get();

    if (!friendship) {
      return reply.code(403).send({ error: 'You can only add friends to group DMs', statusCode: 403 });
    }

    // Validate target is not already a member
    const existingMembership = db.select()
      .from(schema.dmMembers)
      .where(and(
        eq(schema.dmMembers.dmChannelId, id),
        eq(schema.dmMembers.userId, targetUserId),
      ))
      .get();

    if (existingMembership) {
      return reply.code(400).send({ error: 'User is already a member of this DM channel', statusCode: 400 });
    }

    // Validate member count < 10
    const currentMembers = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, id))
      .all();

    if (currentMembers.length >= 10) {
      return reply.code(400).send({ error: 'Group DM cannot exceed 10 members', statusCode: 400 });
    }

    // Insert dm_members row for new user
    db.insert(schema.dmMembers).values({
      dmChannelId: id,
      userId: targetUserId,
    }).run();

    // If the channel doesn't have a federatedId and now has a remote member, assign one
    if (!dmChannel.federatedId && isFederationRelayEnabled()) {
      const domainOrigin = getOurOrigin();
      const participants = getDmParticipants(id);
      const hasRemote = participants.some(p => p.homeInstance !== domainOrigin);

      if (hasRemote) {
        const newFederatedId = computeFederatedId();
        const ownerUser = db.select().from(schema.users).where(eq(schema.users.id, dmChannel.ownerId!)).get();
        db.update(schema.dmChannels)
          .set({
            federatedId: newFederatedId,
            ownerHomeUserId: ownerUser?.homeUserId || dmChannel.ownerId!,
            ownerHomeInstance: ownerUser?.homeInstance || domainOrigin,
          })
          .where(eq(schema.dmChannels.id, id))
          .run();
        // Refresh for subsequent federation code
        dmChannel = {
          ...dmChannel,
          federatedId: newFederatedId,
          ownerHomeUserId: ownerUser?.homeUserId || dmChannel.ownerId!,
          ownerHomeInstance: ownerUser?.homeInstance || domainOrigin,
        };
      }
    }

    // Build full DmChannel response with all members
    const allMemberRows = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, id))
      .all();
    const memberUserIds = allMemberRows.map(m => m.userId);
    const users = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    // Fetch last message
    const lastMsgRows = db.select()
      .from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, id))
      .orderBy(desc(schema.dmMessages.createdAt))
      .limit(1)
      .all();
    const lastMsg = lastMsgRows[0] ?? null;

    const result: DmChannel = {
      id: dmChannel.id,
      ownerId: dmChannel.ownerId ?? null,
      federatedId: dmChannel.federatedId ?? null,
      createdAt: dmChannel.createdAt,
      members: users.map(u => sanitizeUser(u)),
      lastMessage: lastMsg ? {
        id: lastMsg.id,
        dmChannelId: lastMsg.dmChannelId,
        userId: lastMsg.userId,
        content: lastMsg.content,
        createdAt: lastMsg.createdAt,
        type: lastMsg.type === 'system' ? 'system' : 'user',
      } : null,
    };

    const newUser = sanitizeUser(targetUser);

    // Broadcast dm_member_added to all existing members (before the new one)
    for (const member of currentMembers) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_member_added',
        dmChannelId: id,
        user: newUser,
      });
    }

    // Send dm_channel_created to the new member so their sidebar picks it up
    connectionManager.sendToUser(targetUserId, {
      type: 'dm_channel_created',
      dmChannel: result,
    });

    // Insert & broadcast system message for member addition
    const addBaseName = targetUser.username.includes('@') ? targetUser.username.split('@')[0] : targetUser.username;
    const addSysMsg = {
      id: generateSnowflake(),
      dmChannelId: id,
      userId: request.userId,
      content: JSON.stringify({
        event: 'member_added',
        targetUserId: targetUserId,
        targetDisplayName: targetUser.displayName ?? addBaseName,
      }),
      type: 'system' as const,
      createdAt: Date.now(),
      user: db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get(),
      attachments: [],
      embeds: [],
      reactions: [],
    };

    db.insert(schema.dmMessages).values({
      id: addSysMsg.id,
      dmChannelId: addSysMsg.dmChannelId,
      userId: addSysMsg.userId,
      content: addSysMsg.content,
      type: 'system',
      createdAt: addSysMsg.createdAt,
    }).run();

    connectionManager.sendToDmMembers(id, {
      type: 'dm_message_created',
      message: { ...addSysMsg, user: addSysMsg.user ? sanitizeUser(addSysMsg.user) : undefined } as any,
    });

    // Federation: relay member_add to peers
    if (isFederationRelayEnabled() && dmChannel.federatedId) {
      const domainOrigin = getOurOrigin();
      const allParticipants = getDmParticipants(id);

      const addedUser = db.select().from(schema.users).where(eq(schema.users.id, targetUserId)).get();
      const adderUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();

      // Carry the current group metadata snapshot so a fresh peer can
      // bootstrap the channel with the correct name + icon. Re-fetch to
      // pick up any concurrent metadata mutation; the row may have been
      // patched between the start of this handler and now.
      const channelRow = db.select().from(schema.dmChannels)
        .where(eq(schema.dmChannels.id, id)).get();
      const wireIcon = normalizeIconForWire(channelRow?.icon ?? null, domainOrigin);

      const memberAddPayload: FederationRelayEvent = {
        eventType: 'member_add',
        dmChannelId: id,
        messageId: `member_add:${targetUserId}:${Date.now()}`,
        federatedId: dmChannel.federatedId,
        encryptionVersion: 0,
        timestamp: Date.now(),
        membership: {
          user: {
            homeUserId: addedUser?.homeUserId || targetUserId,
            homeInstance: addedUser?.homeInstance || domainOrigin,
          },
          addedBy: {
            homeUserId: adderUser?.homeUserId || request.userId,
            homeInstance: adderUser?.homeInstance || domainOrigin,
          },
        },
        group: {
          owner: {
            homeUserId: dmChannel.ownerHomeUserId || request.userId,
            homeInstance: dmChannel.ownerHomeInstance || domainOrigin,
          },
          members: allParticipants,
          name: channelRow?.name ?? null,
          icon: wireIcon,
          metadataUpdatedAt: channelRow?.metadataUpdatedAt ?? 0,
        },
      };

      // Include the new member's instance in targets even if not previously in the group
      const targetOrigins = getGroupDmTargetOrigins(id);
      // Normalize homeInstance to full URL to match peer origin format
      const rawNewMemberInstance = addedUser?.homeInstance || domainOrigin;
      const newMemberInstance = rawNewMemberInstance.startsWith('http') ? rawNewMemberInstance : `https://${rawNewMemberInstance}`;
      let finalTargets = targetOrigins;
      if (finalTargets && newMemberInstance !== domainOrigin && !finalTargets.includes(newMemberInstance)) {
        finalTargets = [...finalTargets, newMemberInstance];
      }

      appendMutationLog(
        memberAddPayload.messageId,
        id,
        'member_add',
        JSON.stringify(memberAddPayload),
      );
      queueOutboxEvent(
        memberAddPayload.messageId,
        id,
        'member_add',
        JSON.stringify(memberAddPayload),
        finalTargets,
      );
    }

    // Active call sync: if there's an active call in this DM, notify the new member
    const room = connectionManager.getRoom(id);
    if (room && room.roomType === 'dm') {
      const meta = room.metadata as { state: string; callerId: string };
      if (meta.state === 'active' || meta.state === 'ringing') {
        // Look up caller name
        const callerRow = db.select().from(schema.users).where(eq(schema.users.id, meta.callerId)).get();
        const callerName = callerRow?.displayName ?? callerRow?.username ?? meta.callerId;
        connectionManager.sendToUser(targetUserId, {
          type: 'dm_call_incoming',
          dmChannelId: id,
          callerId: meta.callerId,
          callerName,
        });
      }
    }

    return reply.code(200).send(result);
  });

  // DELETE /api/dm/:id/members - Leave a group DM
  app.delete<{ Params: { id: string } }>('/api/dm/:id/members', async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    // Validate caller is a member
    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    // Fetch channel — 1-on-1 DMs (ownerId=NULL) cannot be left, only closed
    const dmChannel = db.select().from(schema.dmChannels).where(and(eq(schema.dmChannels.id, id), isNull(schema.dmChannels.deletedAt))).get();
    if (!dmChannel) {
      return reply.code(404).send({ error: 'DM channel not found', statusCode: 404 });
    }
    if (!dmChannel.ownerId) {
      return reply.code(400).send({ error: 'Cannot leave a 1-on-1 DM. Use DELETE /api/dm/:id to close it.', statusCode: 400 });
    }

    // If user is in this DM's VoiceRoom, leave it first
    evictUserFromDmVoiceRoom(id, request.userId);

    removeDmMember(id, request.userId, request.userId, 'leave');

    // Send dm_channel_closed to the leaving user
    connectionManager.sendToUser(request.userId, {
      type: 'dm_channel_closed',
      dmChannelId: id,
    });

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/dm/:id/members/:targetUserId - Owner kicks a member from a group DM
  app.delete<{ Params: { id: string; targetUserId: string } }>('/api/dm/:id/members/:targetUserId', async (request, reply) => {
    const { id, targetUserId } = request.params;
    const db = getDb();

    // Channel must exist (and not be soft-deleted)
    const dmChannel = db.select().from(schema.dmChannels).where(and(eq(schema.dmChannels.id, id), isNull(schema.dmChannels.deletedAt))).get();
    if (!dmChannel) {
      return reply.code(404).send({ error: 'DM channel not found', statusCode: 404 });
    }

    // 1-on-1 DM rejection (ownerId=NULL signals 1-on-1)
    if (!dmChannel.ownerId) {
      return reply.code(400).send({ error: 'Cannot kick from a 1-on-1 DM', statusCode: 400 });
    }

    // Caller must be the owner
    if (dmChannel.ownerId !== request.userId) {
      return reply.code(403).send({ error: 'Only the group owner can remove members', statusCode: 403 });
    }

    // Owner cannot kick themselves
    if (targetUserId === request.userId) {
      return reply.code(400).send({ error: 'Owners cannot kick themselves; use leave instead', statusCode: 400 });
    }

    // Target must be a current member
    if (!isDmMember(id, targetUserId)) {
      return reply.code(404).send({ error: 'Target user is not a member of this DM channel', statusCode: 404 });
    }

    // If kicked user is in this DM's voice room, evict them first so the call state stays consistent
    evictUserFromDmVoiceRoom(id, targetUserId);

    removeDmMember(id, request.userId, targetUserId, 'kick');

    // Notify the kicked user that they no longer have access to this channel
    connectionManager.sendToUser(targetUserId, {
      type: 'dm_channel_closed',
      dmChannelId: id,
    });

    return reply.code(200).send({ success: true });
  });

  // POST /api/dm/:id/transfer - Owner transfers ownership to another group member without leaving
  app.post<{ Params: { id: string }; Body: { newOwnerId?: unknown } }>('/api/dm/:id/transfer', async (request, reply) => {
    const { id } = request.params;
    const newOwnerId = (request.body as { newOwnerId?: unknown } | null)?.newOwnerId;

    if (typeof newOwnerId !== 'string' || newOwnerId.length === 0) {
      return reply.code(400).send({ error: 'newOwnerId is required', statusCode: 400 });
    }

    const db = getDb();

    // Channel must exist (and not be soft-deleted)
    const dmChannel = db.select().from(schema.dmChannels).where(and(eq(schema.dmChannels.id, id), isNull(schema.dmChannels.deletedAt))).get();
    if (!dmChannel) {
      return reply.code(404).send({ error: 'DM channel not found', statusCode: 404 });
    }

    // 1-on-1 DM rejection (ownerId=NULL signals 1-on-1)
    if (!dmChannel.ownerId) {
      return reply.code(400).send({ error: 'Cannot transfer ownership of a 1-on-1 DM', statusCode: 400 });
    }

    // Caller must be the current owner
    if (dmChannel.ownerId !== request.userId) {
      return reply.code(403).send({ error: 'Only the group owner can transfer ownership', statusCode: 403 });
    }

    // Self-transfer is a no-op
    if (newOwnerId === dmChannel.ownerId) {
      return reply.code(400).send({ error: 'Cannot transfer to current owner', statusCode: 400 });
    }

    // Target must be a current member
    if (!isDmMember(id, newOwnerId)) {
      return reply.code(400).send({ error: 'Target user is not a member of this DM channel', statusCode: 400 });
    }

    const previousOwnerId = dmChannel.ownerId;
    transferGroupDmOwnership(id, previousOwnerId, newOwnerId);

    return reply.code(200).send({ success: true });
  });

  // GET /api/dm/:id/messages - Get DM messages with pagination
  app.get<{ Params: { id: string }; Querystring: PaginatedQuery }>('/api/dm/:id/messages', async (request, reply) => {
    const { id } = request.params;
    const before = request.query.before;
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);

    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    const db = getDb();

    let messageRows: (typeof schema.dmMessages.$inferSelect)[];

    if (before) {
      messageRows = db.select()
        .from(schema.dmMessages)
        .where(and(
          eq(schema.dmMessages.dmChannelId, id),
          lt(schema.dmMessages.id, before)
        ))
        .orderBy(desc(schema.dmMessages.createdAt))
        .limit(limit)
        .all();
    } else {
      messageRows = db.select()
        .from(schema.dmMessages)
        .where(eq(schema.dmMessages.dmChannelId, id))
        .orderBy(desc(schema.dmMessages.createdAt))
        .limit(limit)
        .all();
    }

    messageRows.reverse();

    if (messageRows.length === 0) {
      return reply.code(200).send([]);
    }

    // Batch fetch users
    const userIds = [...new Set(messageRows.map(m => m.userId))];
    const users = db.select().from(schema.users).where(inArray(schema.users.id, userIds)).all();
    const userMap = new Map(users.map(u => [u.id, u]));

    // Batch fetch attachments by dmMessageId
    const messageIds = messageRows.map(m => m.id);
    const allAttachments = db.select()
      .from(schema.attachments)
      .where(inArray(schema.attachments.dmMessageId, messageIds))
      .all();
    const attachmentMap = new Map<string, (typeof schema.attachments.$inferSelect)[]>();
    for (const att of allAttachments) {
      const mid = att.dmMessageId ?? '';
      if (!attachmentMap.has(mid)) attachmentMap.set(mid, []);
      attachmentMap.get(mid)!.push(att);
    }

    // Batch fetch reactions
    const reactionsMap = fetchDmReactionsForMessages(messageIds);

    // Batch fetch embeds
    const embedMap = fetchDmEmbedsForMessages(messageIds);

    // Batch fetch reply-to messages
    const replyToIds = messageRows
      .map(m => m.replyToId)
      .filter((id): id is string => id !== null && id !== undefined);
    const uniqueReplyIds = [...new Set(replyToIds)];
    const replyToMap = new Map<string, DmMessageWithUser>();
    if (uniqueReplyIds.length > 0) {
      const replyMessages = db.select()
        .from(schema.dmMessages)
        .where(inArray(schema.dmMessages.id, uniqueReplyIds))
        .all();
      const replyUserIds = [...new Set(replyMessages.map(m => m.userId))];
      const replyUsers = replyUserIds.length > 0
        ? db.select().from(schema.users).where(inArray(schema.users.id, replyUserIds)).all()
        : [];
      const replyUserMap = new Map(replyUsers.map(u => [u.id, u]));

      for (const rm of replyMessages) {
        const rUser = replyUserMap.get(rm.userId);
        if (!rUser) continue;
        replyToMap.set(rm.id, {
          id: rm.id,
          dmChannelId: rm.dmChannelId,
          userId: rm.userId,
          replyToId: rm.replyToId,
          content: rm.content,
          type: (rm.type ?? 'user') as 'user' | 'system',
          editedAt: rm.editedAt,
          createdAt: rm.createdAt,
          user: sanitizeUser(rUser),
          attachments: [],
          embeds: [],
          reactions: [],
        });
      }
    }

    const messages: DmMessageWithUser[] = messageRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;
        const reactions = reactionsMap.get(m.id) ?? [];
        const replyTo = m.replyToId ? (replyToMap.get(m.replyToId) ?? null) : null;
        return buildDmMessageWithUser(m, user, attachmentMap.get(m.id) ?? [], reactions, replyTo, embedMap.get(m.id) ?? []);
      })
      .filter((m): m is DmMessageWithUser => m !== null);

    return reply.code(200).send(messages);
  });

  // POST /api/dm/space-invite — Send a space invite card to a friend via DM.
  // Trust model: the snapshot is fetched server-to-server from the space's home
  // instance via fetchSpaceInviteSnapshot — never trust client-supplied snapshot data.
  app.post<{ Body: SpaceInviteRequest }>('/api/dm/space-invite', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '60 seconds',
        keyGenerator: (request: any) => request.userId || request.ip,
      },
    },
  }, async (request, reply) => {
    const body = request.body;
    if (!body || !body.spaceId || !body.inviteCode || !body.target) {
      return reply.code(400).send({ error: 'invalid_body', statusCode: 400 });
    }

    const db = getDb();
    const callerId = request.userId;

    // 1. Resolve target user (local id OR federated homeUserId+homeInstance)
    let targetUser: typeof schema.users.$inferSelect | null = null;
    if ('userId' in body.target) {
      targetUser = db.select().from(schema.users)
        .where(eq(schema.users.id, body.target.userId)).get() ?? null;
    } else if ('homeUserId' in body.target && 'homeInstance' in body.target) {
      targetUser = resolveOrCreateReplicatedUser(
        body.target.homeUserId,
        body.target.homeInstance,
        db,
      );
    } else {
      return reply.code(400).send({ error: 'invalid_target', statusCode: 400 });
    }

    if (!targetUser) {
      return reply.code(404).send({ error: 'user_not_found', statusCode: 404 });
    }
    if (targetUser.id === callerId) {
      return reply.code(400).send({ error: 'cannot_invite_self', statusCode: 400 });
    }

    // 2. Friendship check (anti-spam, NOT a permission gate — see spec).
    const friendship = db.select().from(schema.friends).where(
      or(
        and(eq(schema.friends.userId, callerId), eq(schema.friends.friendId, targetUser.id)),
        and(eq(schema.friends.userId, targetUser.id), eq(schema.friends.friendId, callerId)),
      ),
    ).get();
    if (!friendship) {
      return reply.code(400).send({ error: 'not_a_friend', statusCode: 400 });
    }

    // 3. Snapshot lookup. For local spaces, read the DB directly — fetching
    // our own /preview endpoint over HTTPS fails inside Docker (NAT loopback).
    // Cross-instance previews still go through the SSRF-validated HTTP path.
    const ourOrigin = getOurOrigin();
    const spaceOrigin = body.spaceInstanceOrigin || ourOrigin;
    const isLocal = !body.spaceInstanceOrigin || body.spaceInstanceOrigin === ourOrigin;
    const snapshot = isLocal
      ? getLocalInviteSnapshot(body.inviteCode)
      : await fetchSpaceInviteSnapshot(spaceOrigin, body.inviteCode);
    if (!snapshot) {
      return reply.code(400).send({ error: 'invite_invalid', statusCode: 400 });
    }
    if (snapshot.spaceId !== body.spaceId) {
      // spaceId mismatch — code points at a different space than the client claimed.
      return reply.code(400).send({ error: 'invite_invalid', statusCode: 400 });
    }

    // 4. Resolve / create the 1-on-1 DM (delegate to dedup helper).
    const dmChannelId = ensureOneOnOneDmChannel(callerId, targetUser, db);

    // 5. Build content + insert system message.
    const now = Date.now();
    const messageId = generateSnowflake();
    const payload: SpaceInviteSystemPayload = {
      event: 'space_invite',
      spaceId: body.spaceId,
      spaceInstanceOrigin: spaceOrigin,
      inviteCode: body.inviteCode,
      snapshot: {
        spaceName: snapshot.spaceName,
        icon: snapshot.icon,
        avatarColor: snapshot.avatarColor,
        memberCount: snapshot.memberCount,
        description: snapshot.description,
        instanceName: snapshot.instanceName,
      },
    };

    db.insert(schema.dmMessages).values({
      id: messageId,
      dmChannelId,
      userId: callerId,
      content: JSON.stringify(payload),
      type: 'system',
      createdAt: now,
    }).run();

    // 6. Hydrate + broadcast locally.
    const message = getDmMessageWithUser(messageId);
    if (!message) {
      return reply.code(500).send({ error: 'message_lookup_failed', statusCode: 500 });
    }
    broadcastDmMessage(dmChannelId, message);

    // 7. Federation relay if the recipient is on a remote instance.
    if (isFederationRelayEnabled() && targetUser.homeInstance && targetUser.homeInstance !== ourOrigin) {
      queueDmRelay(message, dmChannelId, 'create');
    }

    const response: SpaceInviteResponse = { dmChannelId, messageId, message };
    return reply.code(200).send(response);
  });

  // POST /api/dm/:id/messages - Send a DM message
  app.post<{ Params: { id: string }; Body: CreateDmMessageRequest }>('/api/dm/:id/messages', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '5 seconds',
        keyGenerator: (request: any) => request.userId || request.ip,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { content, attachments: attachmentIds, replyToId } = request.body;

    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    const hasContent = content && typeof content === 'string' && content.trim().length > 0;
    const hasAttachments = attachmentIds && attachmentIds.length > 0;

    if (!hasContent && !hasAttachments) {
      return reply.code(400).send({ error: 'Message must have content or attachments', statusCode: 400 });
    }

    if (content && content.length > MAX_MESSAGE_LENGTH) {
      return reply.code(400).send({ error: `Message content must be ${MAX_MESSAGE_LENGTH} characters or less`, statusCode: 400 });
    }

    const db = getDb();
    const messageId = generateSnowflake();
    const now = Date.now();

    // Verify attachment ownership before linking
    if (attachmentIds && attachmentIds.length > 0) {
      for (const attId of attachmentIds) {
        const att = db.select().from(schema.attachments).where(eq(schema.attachments.id, attId)).get();
        if (!att || att.messageId || att.dmMessageId) {
          return reply.code(400).send({ error: 'Invalid or already-used attachment', statusCode: 400 });
        }
        if (att.uploaderId && att.uploaderId !== request.userId) {
          return reply.code(400).send({ error: 'You do not own this attachment', statusCode: 400 });
        }
      }
    }

    // Insert message and link attachments atomically
    db.transaction((tx) => {
      tx.insert(schema.dmMessages).values({
        id: messageId,
        dmChannelId: id,
        userId: request.userId,
        replyToId: replyToId || null,
        content: content?.trim() || null,
        createdAt: now,
      }).run();

      if (attachmentIds && attachmentIds.length > 0) {
        for (const attId of attachmentIds) {
          tx.update(schema.attachments)
            .set({ dmMessageId: messageId })
            .where(eq(schema.attachments.id, attId))
            .run();
        }
      }
    });

    const message = getDmMessageWithUser(messageId);
    if (!message) {
      return reply.code(500).send({ error: 'Failed to create message', statusCode: 500 });
    }

    // Broadcast to all DM members (including those who closed the channel)
    broadcastDmMessage(id, message);

    // Federation: queue for relay
    queueDmRelay(message, id, 'create');

    // Resolve embeds asynchronously after responding
    setImmediate(() => {
      resolveEmbeds(messageId, content?.trim() || null, id, true, null).catch(() => {});
    });

    return reply.code(201).send(message);
  });

  // PATCH /api/dm/messages/:id - Edit a DM message
  app.patch<{ Params: { id: string }; Body: { content: string } }>('/api/dm/messages/:id', async (request, reply) => {
    const { id } = request.params;
    const { content } = request.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.code(400).send({ error: 'Message content is required', statusCode: 400 });
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
      return reply.code(400).send({ error: `Message content must be ${MAX_MESSAGE_LENGTH} characters or less`, statusCode: 400 });
    }

    const db = getDb();

    const msg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, id)).get();
    if (!msg) {
      return reply.code(404).send({ error: 'Message not found', statusCode: 404 });
    }

    if (msg.userId !== request.userId) {
      return reply.code(403).send({ error: 'You can only edit your own messages', statusCode: 403 });
    }

    const now = Date.now();
    db.update(schema.dmMessages)
      .set({ content: content.trim(), editedAt: now })
      .where(eq(schema.dmMessages.id, id))
      .run();

    // Delete old embeds synchronously so the broadcast reflects the edit
    db.delete(schema.embeds).where(eq(schema.embeds.dmMessageId, id)).run();

    const updated = getDmMessageWithUser(id);
    if (!updated) {
      return reply.code(500).send({ error: 'Failed to update message', statusCode: 500 });
    }

    // Broadcast to all DM members
    const dmMembers = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, msg.dmChannelId))
      .all();

    for (const member of dmMembers) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_message_updated',
        message: updated,
      });
    }

    // Federation: queue for relay
    queueDmRelay(updated, msg.dmChannelId, 'update');

    // Resolve new embeds asynchronously (old ones already deleted above)
    setImmediate(() => {
      resolveEmbeds(id, content.trim(), msg.dmChannelId, true, null).catch(() => {});
    });

    return reply.code(200).send(updated);
  });

  // DELETE /api/dm/messages/:id - Delete a DM message
  app.delete<{ Params: { id: string } }>('/api/dm/messages/:id', async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const msg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, id)).get();
    if (!msg) {
      return reply.code(404).send({ error: 'Message not found', statusCode: 404 });
    }

    if (msg.userId !== request.userId) {
      return reply.code(403).send({ error: 'You can only delete your own messages', statusCode: 403 });
    }

    // Collect attachment filenames before deleting
    const attachmentRows = db.select({ filename: schema.attachments.filename })
      .from(schema.attachments)
      .where(eq(schema.attachments.dmMessageId, id))
      .all();

    // Delete attachments, reactions, and message atomically
    db.transaction((tx) => {
      tx.delete(schema.attachments)
        .where(eq(schema.attachments.dmMessageId, id))
        .run();

      tx.delete(schema.dmReactions)
        .where(eq(schema.dmReactions.dmMessageId, id))
        .run();

      tx.delete(schema.dmMessages)
        .where(eq(schema.dmMessages.id, id))
        .run();
    });

    // Clean up files from disk after transaction commits
    deleteAttachmentFiles(attachmentRows);

    // Broadcast to all DM members
    const dmMembers = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, msg.dmChannelId))
      .all();

    for (const member of dmMembers) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_message_deleted',
        messageId: id,
        dmChannelId: msg.dmChannelId,
      });
    }

    // Federation: log mutation and queue for relay
    appendMutationLog(id, msg.dmChannelId, 'delete');
    queueOutboxEvent(id, msg.dmChannelId, 'delete', JSON.stringify({ deleted: true }));

    return reply.code(200).send({ success: true });
  });
}
