import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt, gt, like, sql, asc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { hasPermission, getChannelSpaceId, PermissionBits, isDmMember } from '../utils/permissions.js';
import { hydrateChannelMessages } from './messages.js';
import { hydrateDmMessages } from './dm.js';

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
      return sendError(reply, 404, 'channel_not_found');
    }

    if (!hasPermission(request.userId, spaceId, PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY, id)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'READ_MESSAGE_HISTORY' });
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

    const results = hydrateChannelMessages(id, messageRows);
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
      return sendError(reply, 403, 'not_dm_member');
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

    const results = hydrateDmMessages(id, messageRows);
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
      return sendError(reply, 400, 'validation_failed');
    }

    const spaceId = getChannelSpaceId(id);
    if (!spaceId) {
      return sendError(reply, 404, 'channel_not_found');
    }

    if (!hasPermission(request.userId, spaceId, PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY, id)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'READ_MESSAGE_HISTORY' });
    }

    const db = getDb();

    // Get the target message to know its timestamp
    const target = db.select().from(schema.messages)
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.channelId, id)))
      .get();
    if (!target) {
      return sendError(reply, 404, 'message_not_found');
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

    return reply.code(200).send(hydrateChannelMessages(id, uniqueRows));
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
      return sendError(reply, 400, 'validation_failed');
    }

    if (!isDmMember(id, request.userId)) {
      return sendError(reply, 403, 'not_dm_member');
    }

    const db = getDb();

    const target = db.select().from(schema.dmMessages)
      .where(and(eq(schema.dmMessages.id, messageId), eq(schema.dmMessages.dmChannelId, id)))
      .get();
    if (!target) {
      return sendError(reply, 404, 'message_not_found');
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

    return reply.code(200).send(hydrateDmMessages(id, uniqueRows));
  });
}
