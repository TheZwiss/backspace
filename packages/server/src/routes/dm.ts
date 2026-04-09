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
} from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';
import { deleteAttachmentFiles } from '../utils/fileCleanup.js';
import { fetchDmEmbedsForMessages, resolveEmbeds, reResolveEmbeds, embedRowToEmbed } from '../utils/embedResolver.js';
import {
  appendMutationLog,
  queueOutboxEvent,
  queueDmRelay,
  queueDmCloseRelay,
  getDmParticipants,
  getGroupDmTargetOrigins,
  isFederationRelayEnabled,
  computeFederatedId,
  sendTypingRelay,
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

    const lastMessageMap = new Map<string, { id: string; dmChannelId: string; userId: string; content: string | null; createdAt: number }>();
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
          createdAt: dmChannel.createdAt,
          members: users.map(u => sanitizeUser(u)),
          lastMessage: lastMsg ? {
            id: lastMsg.id,
            dmChannelId: lastMsg.dmChannelId,
            userId: lastMsg.userId,
            content: lastMsg.content,
            createdAt: lastMsg.createdAt,
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
    const userRoom = connectionManager.getUserRoom(request.userId);
    if (userRoom && userRoom.roomId === id) {
      const left = connectionManager.leaveCurrentRoom(request.userId);
      if (left) {
        // Broadcast voice leave
        connectionManager.sendToDmMembers(id, {
          type: 'voice_state_update',
          channelId: id,
          userId: request.userId,
          action: 'leave',
        });
        // Auto-end call if DM room is now empty
        const updatedRoom = connectionManager.getRoom(id);
        if (updatedRoom && updatedRoom.participants.size === 0) {
          connectionManager.destroyRoom(id);
          connectionManager.sendToDmMembers(id, {
            type: 'dm_call_ended',
            dmChannelId: id,
          });
        }
      }
      connectionManager.clearVoiceUserStatus(request.userId);
    }

    // Compute federation targets BEFORE member deletion so the leaving user's peer is included
    let fedTargetOrigins: string[] | undefined;
    let leavingUser: typeof schema.users.$inferSelect | undefined;
    if (isFederationRelayEnabled() && dmChannel?.federatedId) {
      fedTargetOrigins = getGroupDmTargetOrigins(id);
      leavingUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get() ?? undefined;
    }

    // Insert system message for member leaving (before deletion so they're still a member)
    const leavingUserRow = leavingUser ?? db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    const leaveBaseName = leavingUserRow?.username?.includes('@') ? leavingUserRow.username.split('@')[0] : (leavingUserRow?.username ?? 'Unknown');
    const leaveSysMsgId = generateSnowflake();
    const leaveNow = Date.now();

    db.insert(schema.dmMessages).values({
      id: leaveSysMsgId,
      dmChannelId: id,
      userId: request.userId,
      content: JSON.stringify({
        event: 'member_removed',
        targetUserId: request.userId,
        targetDisplayName: leavingUserRow?.displayName ?? leaveBaseName,
        reason: 'leave',
      }),
      type: 'system',
      createdAt: leaveNow,
    }).run();

    connectionManager.sendToDmMembers(id, {
      type: 'dm_message_created',
      message: {
        id: leaveSysMsgId,
        dmChannelId: id,
        userId: request.userId,
        content: JSON.stringify({
          event: 'member_removed',
          targetUserId: request.userId,
          targetDisplayName: leavingUserRow?.displayName ?? leaveBaseName,
          reason: 'leave',
        }),
        type: 'system',
        createdAt: leaveNow,
        user: leavingUserRow ? sanitizeUser(leavingUserRow) : undefined,
        attachments: [],
        embeds: [],
        reactions: [],
      } as any,
    });

    // Delete dm_members row
    db.delete(schema.dmMembers)
      .where(and(
        eq(schema.dmMembers.dmChannelId, id),
        eq(schema.dmMembers.userId, request.userId),
      ))
      .run();

    // Clean up read_states for the departing user
    db.delete(schema.readStates).where(and(
      eq(schema.readStates.userId, request.userId),
      eq(schema.readStates.channelId, id),
    )).run();

    // Federation: relay member_remove (leave) to peers
    if (isFederationRelayEnabled() && dmChannel?.federatedId) {
      const domainOrigin = getOurOrigin();

      const memberRemovePayload: FederationRelayEvent = {
        eventType: 'member_remove',
        dmChannelId: id,
        messageId: `member_remove:${request.userId}:${Date.now()}`,
        federatedId: dmChannel.federatedId,
        encryptionVersion: 0,
        timestamp: Date.now(),
        membership: {
          user: {
            homeUserId: leavingUser?.homeUserId || request.userId,
            homeInstance: leavingUser?.homeInstance || domainOrigin,
          },
          removedBy: {
            homeUserId: leavingUser?.homeUserId || request.userId,
            homeInstance: leavingUser?.homeInstance || domainOrigin,
          },
          reason: 'leave',
        },
      };

      appendMutationLog(
        memberRemovePayload.messageId,
        id,
        'member_remove',
        JSON.stringify(memberRemovePayload),
      );
      queueOutboxEvent(
        memberRemovePayload.messageId,
        id,
        'member_remove',
        JSON.stringify(memberRemovePayload),
        fedTargetOrigins,
      );
    }

    // Check remaining members
    const remainingMembers = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, id))
      .all();

    if (remainingMembers.length > 0) {
      // Transfer ownership if the leaving user was the owner
      const nextOwner = remainingMembers[0];
      if (dmChannel && dmChannel.ownerId === request.userId && nextOwner) {
        db.update(schema.dmChannels)
          .set({ ownerId: nextOwner.userId })
          .where(eq(schema.dmChannels.id, id))
          .run();

        // Broadcast ownership change via dedicated event
        for (const member of remainingMembers) {
          connectionManager.sendToUser(member.userId, {
            type: 'dm_owner_updated',
            dmChannelId: id,
            newOwnerId: nextOwner.userId,
          });
        }

        // Query new owner user outside federation block so it's available for system message
        const newOwnerUser = db.select().from(schema.users).where(eq(schema.users.id, nextOwner.userId)).get();

        // Insert system message for ownership transfer
        const newOwnerBaseName = newOwnerUser?.username?.includes('@') ? newOwnerUser.username.split('@')[0] : (newOwnerUser?.username ?? 'Unknown');
        const ownerSysMsgId = generateSnowflake();
        const ownerNow = Date.now();

        db.insert(schema.dmMessages).values({
          id: ownerSysMsgId,
          dmChannelId: id,
          userId: request.userId,
          content: JSON.stringify({
            event: 'owner_changed',
            newOwnerId: nextOwner.userId,
            newOwnerDisplayName: newOwnerUser?.displayName ?? newOwnerBaseName,
          }),
          type: 'system',
          createdAt: ownerNow,
        }).run();

        for (const member of remainingMembers) {
          connectionManager.sendToUser(member.userId, {
            type: 'dm_message_created',
            message: {
              id: ownerSysMsgId,
              dmChannelId: id,
              userId: request.userId,
              content: JSON.stringify({
                event: 'owner_changed',
                newOwnerId: nextOwner.userId,
                newOwnerDisplayName: newOwnerUser?.displayName ?? newOwnerBaseName,
              }),
              type: 'system',
              createdAt: ownerNow,
              user: leavingUserRow ? sanitizeUser(leavingUserRow) : undefined,
              attachments: [],
              embeds: [],
              reactions: [],
            } as any,
          });
        }

        // Federation: relay ownership transfer
        if (isFederationRelayEnabled() && dmChannel?.federatedId) {
          const domainOrigin = getOurOrigin();
          const prevOwnerUser = leavingUser; // Already queried above before member deletion

          // Update federated owner columns
          db.update(schema.dmChannels)
            .set({
              ownerHomeUserId: newOwnerUser?.homeUserId || nextOwner.userId,
              ownerHomeInstance: newOwnerUser?.homeInstance || domainOrigin,
            })
            .where(eq(schema.dmChannels.id, id))
            .run();

          const transferPayload: FederationRelayEvent = {
            eventType: 'ownership_transfer',
            dmChannelId: id,
            messageId: `ownership_transfer:${nextOwner.userId}:${Date.now()}`,
            federatedId: dmChannel.federatedId,
            encryptionVersion: 0,
            timestamp: Date.now(),
            ownership: {
              newOwner: {
                homeUserId: newOwnerUser?.homeUserId || nextOwner.userId,
                homeInstance: newOwnerUser?.homeInstance || domainOrigin,
              },
              previousOwner: {
                homeUserId: prevOwnerUser?.homeUserId || request.userId,
                homeInstance: prevOwnerUser?.homeInstance || domainOrigin,
              },
            },
          };

          appendMutationLog(
            transferPayload.messageId,
            id,
            'ownership_transfer',
            JSON.stringify(transferPayload),
          );
          queueOutboxEvent(
            transferPayload.messageId,
            id,
            'ownership_transfer',
            JSON.stringify(transferPayload),
            fedTargetOrigins,
          );
        }
      }

      // Broadcast dm_member_removed to remaining members
      for (const member of remainingMembers) {
        connectionManager.sendToUser(member.userId, {
          type: 'dm_member_removed',
          dmChannelId: id,
          userId: request.userId,
        });
      }
    } else {
      // Last member left — soft-delete for deferred GC (24h grace period)
      db.update(schema.dmChannels)
        .set({ deletedAt: Date.now() })
        .where(eq(schema.dmChannels.id, id))
        .run();
      console.log(`[dm] Group DM ${id} has no remaining members, soft-deleted for GC`);
    }

    // Send dm_channel_closed to the leaving user
    connectionManager.sendToUser(request.userId, {
      type: 'dm_channel_closed',
      dmChannelId: id,
    });

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
