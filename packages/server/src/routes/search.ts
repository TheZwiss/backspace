import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt, gt, like, inArray, sql, asc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { hasPermission, getChannelSpaceId, PermissionBits, isDmMember } from '../utils/permissions.js';
import { fetchReactionsForMessages, fetchReplyToMessages, buildMessageWithUser } from './messages.js';
import { fetchDmReactionsForMessages, buildDmMessageWithUser } from './dm.js';
import { sanitizeUser } from '../utils/sanitize.js';
import type { MessageWithUser, DmMessageWithUser } from '@backspace/shared';
import { fetchEmbedsForMessages, fetchDmEmbedsForMessages } from '../utils/embedResolver.js';

interface SearchQuery {
  q?: string;
  from?: string;
  has?: string;
  before?: string;
  after?: string;
  offset?: string;
  limit?: string;
}

interface AroundQuery {
  messageId: string;
  limit?: string;
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/channels/:id/search — Search messages in a space channel
  app.get<{ Params: { id: string }; Querystring: SearchQuery }>('/api/channels/:id/search', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { q, from, has, before, after } = request.query;
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    const limit = Math.min(Math.max(Number(request.query.limit) || 25, 1), 50);

    const spaceId = getChannelSpaceId(id);
    if (!spaceId) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, spaceId, PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY, id)) {
      return reply.code(403).send({ error: 'Missing permissions', statusCode: 403 });
    }

    const db = getDb();
    const conditions: ReturnType<typeof eq>[] = [eq(schema.messages.channelId, id)];

    if (q && q.trim()) {
      conditions.push(like(schema.messages.content, `%${q.trim()}%`));
    }

    if (from && from.trim()) {
      const user = db.select().from(schema.users)
        .where(like(schema.users.username, from.trim()))
        .get();
      if (user) {
        conditions.push(eq(schema.messages.userId, user.id));
      } else {
        return reply.code(200).send({ results: [], totalCount: 0 });
      }
    }

    if (before) {
      const ts = new Date(before).getTime();
      if (!isNaN(ts)) {
        conditions.push(lt(schema.messages.createdAt, ts));
      }
    }

    if (after) {
      const ts = new Date(after).getTime();
      if (!isNaN(ts)) {
        conditions.push(gt(schema.messages.createdAt, ts));
      }
    }

    const whereClause = and(...conditions)!;

    // Handle has: filter with subqueries
    let hasFilter: ReturnType<typeof sql> | null = null;
    if (has === 'file' || has === 'image') {
      hasFilter = sql`EXISTS (SELECT 1 FROM attachments WHERE attachments.message_id = messages.id${
        has === 'image' ? sql` AND attachments.mimetype LIKE 'image/%'` : sql``
      })`;
    } else if (has === 'link') {
      conditions.push(like(schema.messages.content, '%http%'));
    }

    // Count total
    let countQuery;
    if (hasFilter) {
      countQuery = db.select({ count: sql<number>`count(*)` })
        .from(schema.messages)
        .where(and(whereClause, hasFilter))
        .get();
    } else {
      countQuery = db.select({ count: sql<number>`count(*)` })
        .from(schema.messages)
        .where(whereClause)
        .get();
    }
    const totalCount = countQuery?.count ?? 0;

    // Fetch results
    let messageRows: (typeof schema.messages.$inferSelect)[];
    if (hasFilter) {
      messageRows = db.select()
        .from(schema.messages)
        .where(and(whereClause, hasFilter))
        .orderBy(desc(schema.messages.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
    } else {
      messageRows = db.select()
        .from(schema.messages)
        .where(whereClause)
        .orderBy(desc(schema.messages.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
    }

    if (messageRows.length === 0) {
      return reply.code(200).send({ results: [], totalCount });
    }

    // Hydrate results
    const userIds = [...new Set(messageRows.map(m => m.userId))];
    const users = db.select().from(schema.users).where(inArray(schema.users.id, userIds)).all();
    const userMap = new Map(users.map(u => [u.id, u]));

    const messageIds = messageRows.map(m => m.id);
    const allAttachments = db.select()
      .from(schema.attachments)
      .where(inArray(schema.attachments.messageId, messageIds))
      .all();
    const attachmentMap = new Map<string, (typeof schema.attachments.$inferSelect)[]>();
    for (const att of allAttachments) {
      const mid = att.messageId ?? '';
      if (!attachmentMap.has(mid)) attachmentMap.set(mid, []);
      attachmentMap.get(mid)!.push(att);
    }

    const reactionsMap = fetchReactionsForMessages(messageIds);
    const embedMap = fetchEmbedsForMessages(messageIds);
    const replyToMap = fetchReplyToMessages(messageRows);

    const results: MessageWithUser[] = messageRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;
        const reactions = reactionsMap.get(m.id) ?? [];
        const replyTo = m.replyToId ? (replyToMap.get(m.replyToId) ?? null) : null;
        return buildMessageWithUser(m, user, attachmentMap.get(m.id) ?? [], reactions, replyTo, embedMap.get(m.id) ?? []);
      })
      .filter((m): m is MessageWithUser => m !== null);

    return reply.code(200).send({ results, totalCount });
  });

  // GET /api/dm/:id/search — Search messages in a DM channel
  app.get<{ Params: { id: string }; Querystring: SearchQuery }>('/api/dm/:id/search', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { q, from, has, before, after } = request.query;
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    const limit = Math.min(Math.max(Number(request.query.limit) || 25, 1), 50);

    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    const db = getDb();
    const conditions: ReturnType<typeof eq>[] = [eq(schema.dmMessages.dmChannelId, id)];

    if (q && q.trim()) {
      conditions.push(like(schema.dmMessages.content, `%${q.trim()}%`));
    }

    if (from && from.trim()) {
      const user = db.select().from(schema.users)
        .where(like(schema.users.username, from.trim()))
        .get();
      if (user) {
        conditions.push(eq(schema.dmMessages.userId, user.id));
      } else {
        return reply.code(200).send({ results: [], totalCount: 0 });
      }
    }

    if (before) {
      const ts = new Date(before).getTime();
      if (!isNaN(ts)) {
        conditions.push(lt(schema.dmMessages.createdAt, ts));
      }
    }

    if (after) {
      const ts = new Date(after).getTime();
      if (!isNaN(ts)) {
        conditions.push(gt(schema.dmMessages.createdAt, ts));
      }
    }

    const whereClause = and(...conditions)!;

    let hasFilter: ReturnType<typeof sql> | null = null;
    if (has === 'file' || has === 'image') {
      hasFilter = sql`EXISTS (SELECT 1 FROM attachments WHERE attachments.dm_message_id = dm_messages.id${
        has === 'image' ? sql` AND attachments.mimetype LIKE 'image/%'` : sql``
      })`;
    } else if (has === 'link') {
      conditions.push(like(schema.dmMessages.content, '%http%'));
    }

    let countQuery;
    if (hasFilter) {
      countQuery = db.select({ count: sql<number>`count(*)` })
        .from(schema.dmMessages)
        .where(and(whereClause, hasFilter))
        .get();
    } else {
      countQuery = db.select({ count: sql<number>`count(*)` })
        .from(schema.dmMessages)
        .where(whereClause)
        .get();
    }
    const totalCount = countQuery?.count ?? 0;

    let messageRows: (typeof schema.dmMessages.$inferSelect)[];
    if (hasFilter) {
      messageRows = db.select()
        .from(schema.dmMessages)
        .where(and(whereClause, hasFilter))
        .orderBy(desc(schema.dmMessages.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
    } else {
      messageRows = db.select()
        .from(schema.dmMessages)
        .where(whereClause)
        .orderBy(desc(schema.dmMessages.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
    }

    if (messageRows.length === 0) {
      return reply.code(200).send({ results: [], totalCount });
    }

    // Hydrate
    const userIds = [...new Set(messageRows.map(m => m.userId))];
    const users = db.select().from(schema.users).where(inArray(schema.users.id, userIds)).all();
    const userMap = new Map(users.map(u => [u.id, u]));

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

    const reactionsMap = fetchDmReactionsForMessages(messageIds);
    const embedMap = fetchDmEmbedsForMessages(messageIds);

    // Fetch reply-to messages for DMs
    const replyToIds = messageRows
      .map(m => m.replyToId)
      .filter((rid): rid is string => rid !== null && rid !== undefined);
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
          embeds: [],
          reactions: [],
        });
      }
    }

    const results: DmMessageWithUser[] = messageRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;
        const reactions = reactionsMap.get(m.id) ?? [];
        const replyTo = m.replyToId ? (replyToMap.get(m.replyToId) ?? null) : null;
        return buildDmMessageWithUser(m, user, attachmentMap.get(m.id) ?? [], reactions, replyTo, embedMap.get(m.id) ?? []);
      })
      .filter((m): m is DmMessageWithUser => m !== null);

    return reply.code(200).send({ results, totalCount });
  });

  // GET /api/channels/:id/messages/around — Load messages around a target message
  app.get<{ Params: { id: string }; Querystring: AroundQuery }>('/api/channels/:id/messages/around', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { messageId } = request.query;
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
    const half = Math.floor(limit / 2);

    if (!messageId) {
      return reply.code(400).send({ error: 'messageId is required', statusCode: 400 });
    }

    const spaceId = getChannelSpaceId(id);
    if (!spaceId) {
      return reply.code(404).send({ error: 'Channel not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, spaceId, PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY, id)) {
      return reply.code(403).send({ error: 'Missing permissions', statusCode: 403 });
    }

    const db = getDb();

    // Get the target message to know its timestamp
    const target = db.select().from(schema.messages)
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.channelId, id)))
      .get();
    if (!target) {
      return reply.code(404).send({ error: 'Message not found', statusCode: 404 });
    }

    // Messages before (inclusive of target)
    const beforeRows = db.select()
      .from(schema.messages)
      .where(and(
        eq(schema.messages.channelId, id),
        sql`${schema.messages.id} <= ${messageId}`,
      ))
      .orderBy(desc(schema.messages.createdAt))
      .limit(half + 1)
      .all();

    // Messages after
    const afterRows = db.select()
      .from(schema.messages)
      .where(and(
        eq(schema.messages.channelId, id),
        gt(schema.messages.id, messageId),
      ))
      .orderBy(asc(schema.messages.createdAt))
      .limit(half)
      .all();

    // Combine in chronological order
    beforeRows.reverse();
    const messageRows = [...beforeRows, ...afterRows];

    // Deduplicate (target message appears in both queries)
    const seen = new Set<string>();
    const uniqueRows = messageRows.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    if (uniqueRows.length === 0) {
      return reply.code(200).send([]);
    }

    // Hydrate
    const userIds = [...new Set(uniqueRows.map(m => m.userId))];
    const users = db.select().from(schema.users).where(inArray(schema.users.id, userIds)).all();
    const userMap = new Map(users.map(u => [u.id, u]));

    const msgIds = uniqueRows.map(m => m.id);
    const allAttachments = db.select()
      .from(schema.attachments)
      .where(inArray(schema.attachments.messageId, msgIds))
      .all();
    const attachmentMap = new Map<string, (typeof schema.attachments.$inferSelect)[]>();
    for (const att of allAttachments) {
      const mid = att.messageId ?? '';
      if (!attachmentMap.has(mid)) attachmentMap.set(mid, []);
      attachmentMap.get(mid)!.push(att);
    }

    const reactionsMap = fetchReactionsForMessages(msgIds);
    const embedMap = fetchEmbedsForMessages(msgIds);
    const replyToMap = fetchReplyToMessages(uniqueRows);

    const messages: MessageWithUser[] = uniqueRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;
        const reactions = reactionsMap.get(m.id) ?? [];
        const replyTo = m.replyToId ? (replyToMap.get(m.replyToId) ?? null) : null;
        return buildMessageWithUser(m, user, attachmentMap.get(m.id) ?? [], reactions, replyTo, embedMap.get(m.id) ?? []);
      })
      .filter((m): m is MessageWithUser => m !== null);

    return reply.code(200).send(messages);
  });

  // GET /api/dm/:id/messages/around — Load DM messages around a target message
  app.get<{ Params: { id: string }; Querystring: AroundQuery }>('/api/dm/:id/messages/around', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { messageId } = request.query;
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
    const half = Math.floor(limit / 2);

    if (!messageId) {
      return reply.code(400).send({ error: 'messageId is required', statusCode: 400 });
    }

    if (!isDmMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this DM channel', statusCode: 403 });
    }

    const db = getDb();

    const target = db.select().from(schema.dmMessages)
      .where(and(eq(schema.dmMessages.id, messageId), eq(schema.dmMessages.dmChannelId, id)))
      .get();
    if (!target) {
      return reply.code(404).send({ error: 'Message not found', statusCode: 404 });
    }

    const beforeRows = db.select()
      .from(schema.dmMessages)
      .where(and(
        eq(schema.dmMessages.dmChannelId, id),
        sql`${schema.dmMessages.id} <= ${messageId}`,
      ))
      .orderBy(desc(schema.dmMessages.createdAt))
      .limit(half + 1)
      .all();

    const afterRows = db.select()
      .from(schema.dmMessages)
      .where(and(
        eq(schema.dmMessages.dmChannelId, id),
        gt(schema.dmMessages.id, messageId),
      ))
      .orderBy(asc(schema.dmMessages.createdAt))
      .limit(half)
      .all();

    beforeRows.reverse();
    const messageRows = [...beforeRows, ...afterRows];

    const seen = new Set<string>();
    const uniqueRows = messageRows.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    if (uniqueRows.length === 0) {
      return reply.code(200).send([]);
    }

    // Hydrate
    const userIds = [...new Set(uniqueRows.map(m => m.userId))];
    const users = db.select().from(schema.users).where(inArray(schema.users.id, userIds)).all();
    const userMap = new Map(users.map(u => [u.id, u]));

    const msgIds = uniqueRows.map(m => m.id);
    const allAttachments = db.select()
      .from(schema.attachments)
      .where(inArray(schema.attachments.dmMessageId, msgIds))
      .all();
    const attachmentMap = new Map<string, (typeof schema.attachments.$inferSelect)[]>();
    for (const att of allAttachments) {
      const mid = att.dmMessageId ?? '';
      if (!attachmentMap.has(mid)) attachmentMap.set(mid, []);
      attachmentMap.get(mid)!.push(att);
    }

    const reactionsMap = fetchDmReactionsForMessages(msgIds);
    const embedMap = fetchDmEmbedsForMessages(msgIds);

    const replyToIds = uniqueRows
      .map(m => m.replyToId)
      .filter((rid): rid is string => rid !== null && rid !== undefined);
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
          embeds: [],
          reactions: [],
        });
      }
    }

    const messages: DmMessageWithUser[] = uniqueRows
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
}
