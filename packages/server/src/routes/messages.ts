import type { FastifyInstance } from 'fastify';
import { eq, desc, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, getChannelServerId, isAdmin } from '../utils/permissions.js';
import { connectionManager } from '../ws/handler.js';
import type {
  CreateMessageRequest,
  UpdateMessageRequest,
  PaginatedQuery,
  User,
  MessageWithUser,
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
 * Fetch reactions for a set of message IDs.
 * Returns a map from messageId to Reaction[].
 */
function fetchReactionsForMessages(messageIds: string[]): Map<string, Reaction[]> {
  if (messageIds.length === 0) return new Map();
  const db = getDb();
  const reactionRows = db.select()
    .from(schema.reactions)
    .where(inArray(schema.reactions.messageId, messageIds))
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
      messageId: r.messageId,
      userId: r.userId,
      emoji: r.emoji,
      createdAt: r.createdAt,
      user: user ? sanitizeUser(user) : undefined,
    };
    if (!map.has(r.messageId)) {
      map.set(r.messageId, []);
    }
    map.get(r.messageId)!.push(reaction);
  }
  return map;
}

/**
 * Fetch reply-to messages for a set of message IDs.
 * Returns a map from messageId to its reply parent MessageWithUser.
 */
function fetchReplyToMessages(messages: (typeof schema.messages.$inferSelect)[]): Map<string, MessageWithUser> {
  const replyToIds = messages
    .map(m => m.replyToId)
    .filter((id): id is string => id !== null && id !== undefined);

  if (replyToIds.length === 0) return new Map();

  const db = getDb();
  const uniqueReplyIds = [...new Set(replyToIds)];
  const replyMessages = db.select()
    .from(schema.messages)
    .where(inArray(schema.messages.id, uniqueReplyIds))
    .all();

  // Fetch users for reply messages
  const replyUserIds = [...new Set(replyMessages.map(m => m.userId))];
  const replyUsers = replyUserIds.length > 0
    ? db.select().from(schema.users).where(inArray(schema.users.id, replyUserIds)).all()
    : [];
  const replyUserMap = new Map(replyUsers.map(u => [u.id, u]));

  // Fetch attachments for reply messages
  const replyMsgIds = replyMessages.map(m => m.id);
  const replyAttachments = replyMsgIds.length > 0
    ? db.select().from(schema.attachments).where(inArray(schema.attachments.messageId, replyMsgIds)).all()
    : [];
  const replyAttMap = new Map<string, (typeof schema.attachments.$inferSelect)[]>();
  for (const att of replyAttachments) {
    const mid = att.messageId ?? '';
    if (!replyAttMap.has(mid)) replyAttMap.set(mid, []);
    replyAttMap.get(mid)!.push(att);
  }

  const map = new Map<string, MessageWithUser>();
  for (const rm of replyMessages) {
    const user = replyUserMap.get(rm.userId);
    if (!user) continue;
    const atts = replyAttMap.get(rm.id) ?? [];
    map.set(rm.id, {
      id: rm.id,
      channelId: rm.channelId,
      userId: rm.userId,
      replyToId: rm.replyToId,
      content: rm.content,
      editedAt: rm.editedAt,
      createdAt: rm.createdAt,
      user: sanitizeUser(user),
      attachments: atts.map(a => ({
        id: a.id,
        messageId: a.messageId ?? rm.id,
        filename: a.filename,
        originalName: a.originalName,
        mimetype: a.mimetype,
        size: a.size,
        createdAt: a.createdAt,
      })),
      reactions: [],
      replyTo: null,
    });
  }
  return map;
}

function buildMessageWithUser(
  message: typeof schema.messages.$inferSelect,
  user: typeof schema.users.$inferSelect,
  attachmentRows: (typeof schema.attachments.$inferSelect)[],
  reactions: Reaction[] = [],
  replyTo: MessageWithUser | null = null,
): MessageWithUser {
  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    replyToId: message.replyToId,
    content: message.content,
    editedAt: message.editedAt,
    createdAt: message.createdAt,
    user: sanitizeUser(user),
    attachments: attachmentRows.map(a => ({
      id: a.id,
      messageId: a.messageId ?? message.id,
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

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/channels/:id/messages - Get messages with cursor pagination
  app.get<{ Params: { id: string }; Querystring: PaginatedQuery }>('/api/channels/:id/messages', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const before = request.query.before;
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);

    const serverId = getChannelServerId(id);
    if (!serverId) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    if (!isMember(serverId, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this server', statusCode: 403 });
    }

    const db = getDb();

    let messageRows: (typeof schema.messages.$inferSelect)[];

    if (before) {
      messageRows = db.select()
        .from(schema.messages)
        .where(eq(schema.messages.channelId, id))
        .orderBy(desc(schema.messages.createdAt))
        .all()
        .filter(m => m.id < before)
        .slice(0, limit);
    } else {
      messageRows = db.select()
        .from(schema.messages)
        .where(eq(schema.messages.channelId, id))
        .orderBy(desc(schema.messages.createdAt))
        .limit(limit)
        .all();
    }

    // Reverse to get chronological order
    messageRows.reverse();

    if (messageRows.length === 0) {
      return reply.code(200).send([]);
    }

    // Batch fetch users
    const userIds = [...new Set(messageRows.map(m => m.userId))];
    const users = db.select().from(schema.users).where(inArray(schema.users.id, userIds)).all();
    const userMap = new Map(users.map(u => [u.id, u]));

    // Batch fetch attachments
    const messageIds = messageRows.map(m => m.id);
    const allAttachments = db.select()
      .from(schema.attachments)
      .where(inArray(schema.attachments.messageId, messageIds))
      .all();

    const attachmentMap = new Map<string, (typeof schema.attachments.$inferSelect)[]>();
    for (const att of allAttachments) {
      const mid = att.messageId ?? '';
      if (!attachmentMap.has(mid)) {
        attachmentMap.set(mid, []);
      }
      attachmentMap.get(mid)!.push(att);
    }

    // Batch fetch reactions for all messages
    const reactionsMap = fetchReactionsForMessages(messageIds);

    // Batch fetch reply-to messages
    const replyToMap = fetchReplyToMessages(messageRows);

    const messages: MessageWithUser[] = messageRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;
        const reactions = reactionsMap.get(m.id) ?? [];
        const replyTo = m.replyToId ? (replyToMap.get(m.replyToId) ?? null) : null;
        return buildMessageWithUser(m, user, attachmentMap.get(m.id) ?? [], reactions, replyTo);
      })
      .filter((m): m is MessageWithUser => m !== null);

    return reply.code(200).send(messages);
  });

  // POST /api/channels/:id/messages - Create a message
  app.post<{ Params: { id: string }; Body: CreateMessageRequest }>('/api/channels/:id/messages', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { content, attachments: attachmentIds, replyToId } = request.body;

    const serverId = getChannelServerId(id);
    if (!serverId) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    if (!isMember(serverId, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this server', statusCode: 403 });
    }

    if ((!content || typeof content !== 'string' || content.trim().length === 0) &&
        (!attachmentIds || attachmentIds.length === 0)) {
      return reply.code(400).send({ error: 'Message must have content or attachments', statusCode: 400 });
    }

    const db = getDb();
    const messageId = generateSnowflake();
    const now = Date.now();

    db.insert(schema.messages).values({
      id: messageId,
      channelId: id,
      userId: request.userId,
      replyToId: replyToId || null,
      content: content?.trim() || null,
      createdAt: now,
    }).run();

    // Link attachments to message
    if (attachmentIds && attachmentIds.length > 0) {
      for (const attId of attachmentIds) {
        db.update(schema.attachments)
          .set({ messageId })
          .where(eq(schema.attachments.id, attId))
          .run();
      }
    }

    const user = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!user) {
      return reply.code(500).send({ error: 'User not found', statusCode: 500 });
    }

    const attachmentRows = db.select()
      .from(schema.attachments)
      .where(eq(schema.attachments.messageId, messageId))
      .all();

    const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
    if (!message) {
      return reply.code(500).send({ error: 'Failed to create message', statusCode: 500 });
    }

    // Hydrate the reply-to message if present
    let replyTo: MessageWithUser | null = null;
    if (message.replyToId) {
      const replyToMap = fetchReplyToMessages([message]);
      replyTo = replyToMap.get(message.replyToId) ?? null;
    }

    const messageWithUser = buildMessageWithUser(message, user, attachmentRows, [], replyTo);

    // Broadcast via WebSocket
    connectionManager.sendToServer(serverId, {
      type: 'message_created',
      message: messageWithUser,
    });

    return reply.code(201).send(messageWithUser);
  });

  // PATCH /api/messages/:id - Edit a message (author only)
  app.patch<{ Params: { id: string }; Body: UpdateMessageRequest }>('/api/messages/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { content } = request.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.code(400).send({ error: 'Content is required', statusCode: 400 });
    }

    const db = getDb();
    const message = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    if (!message) {
      return reply.code(404).send({ error: 'Message not found', statusCode: 404 });
    }

    if (message.userId !== request.userId) {
      return reply.code(403).send({ error: 'You can only edit your own messages', statusCode: 403 });
    }

    const now = Date.now();
    db.update(schema.messages)
      .set({ content: content.trim(), editedAt: now })
      .where(eq(schema.messages.id, id))
      .run();

    const updatedMessage = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    if (!updatedMessage) {
      return reply.code(500).send({ error: 'Failed to update message', statusCode: 500 });
    }

    const user = db.select().from(schema.users).where(eq(schema.users.id, message.userId)).get();
    if (!user) {
      return reply.code(500).send({ error: 'User not found', statusCode: 500 });
    }

    const attachmentRows = db.select()
      .from(schema.attachments)
      .where(eq(schema.attachments.messageId, id))
      .all();

    // Hydrate reactions and reply-to
    const reactionsMap = fetchReactionsForMessages([id]);
    const reactions = reactionsMap.get(id) ?? [];
    let replyTo: MessageWithUser | null = null;
    if (updatedMessage.replyToId) {
      const replyToMap = fetchReplyToMessages([updatedMessage]);
      replyTo = replyToMap.get(updatedMessage.replyToId) ?? null;
    }

    const messageWithUser = buildMessageWithUser(updatedMessage, user, attachmentRows, reactions, replyTo);

    // Broadcast edit
    const serverId = getChannelServerId(message.channelId);
    if (serverId) {
      connectionManager.sendToServer(serverId, {
        type: 'message_updated',
        message: messageWithUser,
      });
    }

    return reply.code(200).send(messageWithUser);
  });

  // DELETE /api/messages/:id - Delete a message (author or admin)
  app.delete<{ Params: { id: string } }>('/api/messages/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const message = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    if (!message) {
      return reply.code(404).send({ error: 'Message not found', statusCode: 404 });
    }

    const serverId = getChannelServerId(message.channelId);
    if (!serverId) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    const isAuthor = message.userId === request.userId;
    const isAdminUser = isAdmin(serverId, request.userId);

    if (!isAuthor && !isAdminUser) {
      return reply.code(403).send({ error: 'You cannot delete this message', statusCode: 403 });
    }

    // Delete attachments then message
    db.delete(schema.attachments).where(eq(schema.attachments.messageId, id)).run();
    db.delete(schema.messages).where(eq(schema.messages.id, id)).run();

    // Broadcast deletion
    connectionManager.sendToServer(serverId, {
      type: 'message_deleted',
      messageId: id,
      channelId: message.channelId,
    });

    return reply.code(200).send({ success: true });
  });
}
