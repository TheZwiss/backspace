import type { FastifyInstance } from 'fastify';
import {
  BOOKMARK_KINDS,
  BOOKMARKS_PAGE_DEFAULT,
  BOOKMARKS_PAGE_MAX,
  type BookmarkKind,
} from '@backspace/shared/src/bookmarks.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { connectionManager } from '../ws/handler.js';
import {
  createBookmark,
  deleteBookmark,
  listBookmarkedMessageIds,
  listBookmarks,
  parseBookmarkCursor,
} from '../utils/bookmarks.js';

const kindSchema = { type: 'string', enum: [...BOOKMARK_KINDS] } as const;
const idSchema = { type: 'string', minLength: 1, maxLength: 64 } as const;
const bookmarkParamsSchema = {
  type: 'object', required: ['kind', 'messageId'],
  properties: { kind: kindSchema, messageId: idSchema },
} as const;

interface BookmarkParams {
  kind: BookmarkKind;
  messageId: string;
}

/**
 * Personal bookmarks (docs/systems/bookmarks.md). Every route reads and writes
 * the caller's own bookmarks only. A bookmark lives on the instance that serves
 * the message, so a client asks the instance of the conversation it is in.
 * A change is pushed to the caller's own sockets as `bookmark_added` /
 * `bookmark_removed` (docs/systems/websocket.md); nothing is relayed.
 */
export async function bookmarkRoutes(app: FastifyInstance): Promise<void> {
  // The caller's bookmarks, newest first. Paged: a user has no bookmark limit.
  app.get<{ Querystring: { cursor?: string; limit?: number } }>('/api/bookmarks', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cursor: { type: 'string', minLength: 1, maxLength: 100 },
          limit: { type: 'integer', minimum: 1, maximum: BOOKMARKS_PAGE_MAX, default: BOOKMARKS_PAGE_DEFAULT },
        },
      },
    },
  }, async (request, reply) => {
    const { cursor: rawCursor, limit } = request.query;
    const cursor = rawCursor === undefined ? null : parseBookmarkCursor(rawCursor);
    if (rawCursor !== undefined && !cursor) return sendError(reply, 400, 'validation_failed');
    return listBookmarks(request.userId, { cursor, limit });
  });

  // Which messages of one channel or DM the caller has bookmarked: bounded by the
  // conversation, not by the user's total, so a client can ask on every open.
  app.get<{ Querystring: { kind: BookmarkKind; channelId: string } }>('/api/bookmarks/keys', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object', required: ['kind', 'channelId'], additionalProperties: false,
        properties: { kind: kindSchema, channelId: idSchema },
      },
    },
  }, async (request) => {
    const { kind, channelId } = request.query;
    return listBookmarkedMessageIds(request.userId, kind, channelId);
  });

  // Idempotent: 201 for a new bookmark, 200 when the message was already bookmarked.
  app.put<{ Params: BookmarkParams }>('/api/bookmarks/:kind/:messageId', {
    preHandler: authenticate,
    schema: { params: bookmarkParamsSchema },
  }, async (request, reply) => {
    const { kind, messageId } = request.params;
    const result = createBookmark(request.userId, kind, messageId);
    if (!result.ok) return sendError(reply, result.status, result.code);
    // The caller's other sessions on this instance learn of it; nobody else does.
    if (result.created) connectionManager.sendToUser(request.userId, { type: 'bookmark_added', bookmark: result.bookmark });
    return reply.code(result.created ? 201 : 200).send(result.bookmark);
  });

  // Idempotent: removing a bookmark that is not there is still a success.
  app.delete<{ Params: BookmarkParams }>('/api/bookmarks/:kind/:messageId', {
    preHandler: authenticate,
    schema: { params: bookmarkParamsSchema },
  }, async (request) => {
    const { kind, messageId } = request.params;
    const removed = deleteBookmark(request.userId, kind, messageId);
    if (removed) {
      connectionManager.sendToUser(request.userId, { type: 'bookmark_removed', kind, channelId: removed.channelId, messageId });
    }
    return { success: true };
  });
}
