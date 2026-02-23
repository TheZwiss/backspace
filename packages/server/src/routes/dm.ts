import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isDmMember } from '../utils/permissions.js';
import { connectionManager } from '../ws/handler.js';
import type {
  User,
  DmChannel,
  DmMessage,
  DmMessageWithUser,
  CreateDmRequest,
  CreateDmMessageRequest,
  AddDmMemberRequest,
  PaginatedQuery,
  Attachment,
  Reaction,
} from '@opencord/shared';

function sanitizeUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatar: row.avatar,
    status: (row.status ?? 'offline') as User['status'],
    customStatus: row.customStatus,
    createdAt: row.createdAt,
  };
}

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
): DmMessageWithUser {
  return {
    id: message.id,
    dmChannelId: message.dmChannelId,
    userId: message.userId,
    replyToId: message.replyToId,
    content: message.content,
    editedAt: message.editedAt,
    createdAt: message.createdAt,
    user: sanitizeUser(user),
    attachments: attachmentRows.map(a => ({
      id: a.id,
      messageId: a.dmMessageId ?? message.id,
      filename: a.filename,
      originalName: a.originalName,
      mimetype: a.mimetype,
      size: a.size,
      createdAt: a.createdAt,
    })),
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
          reactions: [],
        };
      }
    }
  }

  return buildDmMessageWithUser(message, user, attachmentRows, reactions, replyTo);
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
        .where(eq(schema.dmChannels.id, dmChannelId))
        .get();

      if (dmChannel) {
        connectionManager.sendToUser(member.userId, {
          type: 'dm_channel_created',
          dmChannel: {
            id: dmChannel.id,
            createdAt: dmChannel.createdAt,
            members: users.map(sanitizeUser),
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
  // GET /api/dm - List user's DM channels
  app.get('/api/dm', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();

    const memberships = db.select()
      .from(schema.dmMembers)
      .where(and(
        eq(schema.dmMembers.userId, request.userId),
        eq(schema.dmMembers.closed, 0),
      ))
      .all();

    const dmChannels: DmChannel[] = [];

    for (const membership of memberships) {
      const dmChannel = db.select()
        .from(schema.dmChannels)
        .where(eq(schema.dmChannels.id, membership.dmChannelId))
        .get();

      if (!dmChannel) continue;

      const dmMemberRows = db.select()
        .from(schema.dmMembers)
        .where(eq(schema.dmMembers.dmChannelId, membership.dmChannelId))
        .all();

      const memberUserIds = dmMemberRows.map(m => m.userId);
      const users = memberUserIds.length > 0
        ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
        : [];

      // Get last message
      const allMessages = db.select()
        .from(schema.dmMessages)
        .where(eq(schema.dmMessages.dmChannelId, membership.dmChannelId))
        .orderBy(desc(schema.dmMessages.createdAt))
        .limit(1)
        .all();

      const lastMessage = allMessages[0] ?? null;

      dmChannels.push({
        id: dmChannel.id,
        createdAt: dmChannel.createdAt,
        members: users.map(sanitizeUser),
        lastMessage: lastMessage ? {
          id: lastMessage.id,
          dmChannelId: lastMessage.dmChannelId,
          userId: lastMessage.userId,
          content: lastMessage.content,
          createdAt: lastMessage.createdAt,
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
  app.post<{ Body: CreateDmRequest }>('/api/dm', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { userId } = request.body;

    if (!userId || typeof userId !== 'string') {
      return reply.code(400).send({ error: 'userId is required', statusCode: 400 });
    }

    if (userId === request.userId) {
      return reply.code(400).send({ error: 'Cannot create DM with yourself', statusCode: 400 });
    }

    const db = getDb();

    // Check if target user exists
    const targetUser = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!targetUser) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
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
          eq(schema.dmMembers.userId, userId),
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

        // DM channel already exists between these users
        const dmChannel = db.select()
          .from(schema.dmChannels)
          .where(eq(schema.dmChannels.id, myDm.dmChannelId))
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
          createdAt: dmChannel.createdAt,
          members: users.map(sanitizeUser),
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

    // Create new DM channel
    const dmChannelId = generateSnowflake();
    const now = Date.now();

    db.insert(schema.dmChannels).values({
      id: dmChannelId,
      createdAt: now,
    }).run();

    db.insert(schema.dmMembers).values({
      dmChannelId,
      userId: request.userId,
    }).run();

    db.insert(schema.dmMembers).values({
      dmChannelId,
      userId,
    }).run();

    const currentUserRow = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    const members = [currentUserRow, targetUser]
      .filter((u): u is NonNullable<typeof u> => u !== undefined)
      .map(sanitizeUser);

    const result: DmChannel = {
      id: dmChannelId,
      createdAt: now,
      members,
      lastMessage: null,
    };

    // Broadcast dm_channel_created to the other user so their sidebar updates
    connectionManager.sendToUser(userId, {
      type: 'dm_channel_created',
      dmChannel: result,
    });

    return reply.code(201).send(result);
  });

  // DELETE /api/dm/:id - Close (hide) a DM channel for the requesting user
  app.delete<{ Params: { id: string } }>('/api/dm/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
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

    return reply.code(200).send({ success: true });
  });

  // POST /api/dm/:id/members - Add a user to an existing DM channel (group DM upgrade)
  app.post<{ Params: { id: string }; Body: AddDmMemberRequest }>('/api/dm/:id/members', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { userId: targetUserId } = request.body;

    if (!targetUserId || typeof targetUserId !== 'string') {
      return reply.code(400).send({ error: 'userId is required', statusCode: 400 });
    }

    const db = getDb();

    // Validate caller is a member
    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    // Validate target user exists
    const targetUser = db.select().from(schema.users).where(eq(schema.users.id, targetUserId)).get();
    if (!targetUser) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
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

    // Build full DmChannel response with all members
    const allMemberRows = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, id))
      .all();
    const memberUserIds = allMemberRows.map(m => m.userId);
    const users = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    const dmChannel = db.select()
      .from(schema.dmChannels)
      .where(eq(schema.dmChannels.id, id))
      .get();

    if (!dmChannel) {
      return reply.code(404).send({ error: 'DM channel not found', statusCode: 404 });
    }

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
      createdAt: dmChannel.createdAt,
      members: users.map(sanitizeUser),
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
  app.delete<{ Params: { id: string } }>('/api/dm/:id/members', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    // Validate caller is a member
    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    // Count members — can't leave a 1-on-1
    const memberRows = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, id))
      .all();

    if (memberRows.length <= 2) {
      return reply.code(400).send({ error: 'Cannot leave a 1-on-1 DM. Use close instead.', statusCode: 400 });
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

    // Delete dm_members row
    db.delete(schema.dmMembers)
      .where(and(
        eq(schema.dmMembers.dmChannelId, id),
        eq(schema.dmMembers.userId, request.userId),
      ))
      .run();

    // Broadcast dm_member_removed to remaining members
    const remainingMembers = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, id))
      .all();

    for (const member of remainingMembers) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_member_removed',
        dmChannelId: id,
        userId: request.userId,
      });
    }

    // Send dm_channel_closed to the leaving user
    connectionManager.sendToUser(request.userId, {
      type: 'dm_channel_closed',
      dmChannelId: id,
    });

    return reply.code(200).send({ success: true });
  });

  // GET /api/dm/:id/messages - Get DM messages with pagination
  app.get<{ Params: { id: string }; Querystring: PaginatedQuery }>('/api/dm/:id/messages', {
    preHandler: authenticate,
  }, async (request, reply) => {
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
          editedAt: rm.editedAt,
          createdAt: rm.createdAt,
          user: sanitizeUser(rUser),
          attachments: [],
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
        return buildDmMessageWithUser(m, user, attachmentMap.get(m.id) ?? [], reactions, replyTo);
      })
      .filter((m): m is DmMessageWithUser => m !== null);

    return reply.code(200).send(messages);
  });

  // POST /api/dm/:id/messages - Send a DM message
  app.post<{ Params: { id: string }; Body: CreateDmMessageRequest }>('/api/dm/:id/messages', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { content, attachments: attachmentIds, replyToId } = request.body;

    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    if ((!content || typeof content !== 'string' || content.trim().length === 0) &&
        (!attachmentIds || attachmentIds.length === 0)) {
      return reply.code(400).send({ error: 'Message must have content or attachments', statusCode: 400 });
    }

    const db = getDb();
    const messageId = generateSnowflake();
    const now = Date.now();

    db.insert(schema.dmMessages).values({
      id: messageId,
      dmChannelId: id,
      userId: request.userId,
      replyToId: replyToId || null,
      content: content?.trim() || null,
      createdAt: now,
    }).run();

    // Link attachments to this DM message
    if (attachmentIds && attachmentIds.length > 0) {
      for (const attId of attachmentIds) {
        db.update(schema.attachments)
          .set({ dmMessageId: messageId })
          .where(eq(schema.attachments.id, attId))
          .run();
      }
    }

    const message = getDmMessageWithUser(messageId);
    if (!message) {
      return reply.code(500).send({ error: 'Failed to create message', statusCode: 500 });
    }

    // Broadcast to all DM members (including those who closed the channel)
    broadcastDmMessage(id, message);

    return reply.code(201).send(message);
  });

  // PATCH /api/dm/messages/:id - Edit a DM message
  app.patch<{ Params: { id: string }; Body: { content: string } }>('/api/dm/messages/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { content } = request.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.code(400).send({ error: 'Message content is required', statusCode: 400 });
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

    return reply.code(200).send(updated);
  });

  // DELETE /api/dm/messages/:id - Delete a DM message
  app.delete<{ Params: { id: string } }>('/api/dm/messages/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const msg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, id)).get();
    if (!msg) {
      return reply.code(404).send({ error: 'Message not found', statusCode: 404 });
    }

    if (msg.userId !== request.userId) {
      return reply.code(403).send({ error: 'You can only delete your own messages', statusCode: 403 });
    }

    // Delete attachments linked to this DM message
    db.delete(schema.attachments)
      .where(eq(schema.attachments.dmMessageId, id))
      .run();

    // Delete reactions
    db.delete(schema.dmReactions)
      .where(eq(schema.dmReactions.dmMessageId, id))
      .run();

    // Delete message
    db.delete(schema.dmMessages)
      .where(eq(schema.dmMessages.id, id))
      .run();

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

    return reply.code(200).send({ success: true });
  });
}
