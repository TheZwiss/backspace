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
  PaginatedQuery,
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

    const messages: DmMessageWithUser[] = messageRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;
        return {
          id: m.id,
          dmChannelId: m.dmChannelId,
          userId: m.userId,
          content: m.content,
          createdAt: m.createdAt,
          user: sanitizeUser(user),
        };
      })
      .filter((m): m is DmMessageWithUser => m !== null);

    return reply.code(200).send(messages);
  });

  // POST /api/dm/:id/messages - Send a DM message
  app.post<{ Params: { id: string }; Body: CreateDmMessageRequest }>('/api/dm/:id/messages', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { content } = request.body;

    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.code(400).send({ error: 'Message content is required', statusCode: 400 });
    }

    const db = getDb();
    const messageId = generateSnowflake();
    const now = Date.now();

    db.insert(schema.dmMessages).values({
      id: messageId,
      dmChannelId: id,
      userId: request.userId,
      content: content.trim(),
      createdAt: now,
    }).run();

    const user = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!user) {
      return reply.code(500).send({ error: 'User not found', statusCode: 500 });
    }

    const message: DmMessageWithUser = {
      id: messageId,
      dmChannelId: id,
      userId: request.userId,
      content: content.trim(),
      createdAt: now,
      user: sanitizeUser(user),
    };

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

    const user = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!user) {
      return reply.code(500).send({ error: 'User not found', statusCode: 500 });
    }

    const updated: DmMessageWithUser = {
      id: msg.id,
      dmChannelId: msg.dmChannelId,
      userId: msg.userId,
      content: content.trim(),
      editedAt: now,
      createdAt: msg.createdAt,
      user: sanitizeUser(user),
    };

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
