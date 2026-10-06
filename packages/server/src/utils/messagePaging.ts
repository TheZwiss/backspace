import { asc, desc, gt, lt, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { FastifyReply } from 'fastify';
import { MESSAGE_PAGING_AFTER, MESSAGE_PAGING_HEADER } from '@backspace/shared';

/**
 * Cursor paging shared by the channel and DM message history endpoints.
 * The wire contract is documented once, in docs/systems/api.md, "Message
 * history paging".
 */

export const HISTORY_PAGE_DEFAULT_LIMIT = 50;
export const HISTORY_PAGE_MAX_LIMIT = 100;

export type HistoryPage =
  | { direction: 'latest'; limit: number }
  | { direction: 'before'; cursor: string; limit: number }
  | { direction: 'after'; cursor: string; limit: number };

export type HistoryPageParse =
  | { ok: true; page: HistoryPage }
  | { ok: false; code: 'paging_cursor_conflict' | 'validation_failed' };

/** The query a history request arrives with, before anything is trusted. */
export interface HistoryPageQuery {
  before?: unknown;
  after?: unknown;
  limit?: unknown;
}

/** The fields of a stored message a history page is cut and ordered by. */
export interface HistoryPageRow {
  id: string;
  createdAt: number;
}

/** The columns of the same fields, for the query. */
export interface HistoryPageColumns {
  id: SQLiteColumn;
  createdAt: SQLiteColumn;
}

type CursorRead = { ok: true; cursor: string | null } | { ok: false };

/**
 * An absent or empty cursor is no cursor, which is how `before` has always
 * been read. A repeated parameter arrives as an array and is refused rather
 * than read as absent: answering it with the newest page would look like a
 * server that ignores the parameter.
 */
function readCursor(value: unknown): CursorRead {
  if (value === undefined || value === '') return { ok: true, cursor: null };
  if (typeof value !== 'string') return { ok: false };
  return { ok: true, cursor: value };
}

/** Read `before`, `after` and `limit` from a history query. */
export function parseHistoryPage(query: HistoryPageQuery): HistoryPageParse {
  const limit = Math.min(Math.max(Number(query.limit) || HISTORY_PAGE_DEFAULT_LIMIT, 1), HISTORY_PAGE_MAX_LIMIT);
  const before = readCursor(query.before);
  const after = readCursor(query.after);
  if (!before.ok || !after.ok) {
    return { ok: false, code: 'validation_failed' };
  }

  if (before.cursor !== null && after.cursor !== null) {
    return { ok: false, code: 'paging_cursor_conflict' };
  }
  if (before.cursor !== null) return { ok: true, page: { direction: 'before', cursor: before.cursor, limit } };
  if (after.cursor !== null) return { ok: true, page: { direction: 'after', cursor: after.cursor, limit } };
  return { ok: true, page: { direction: 'latest', limit } };
}

/**
 * Compare two snowflake ids numerically. They are stored as decimal text, so
 * a shorter id is the smaller one and ids of one length compare as strings.
 */
function compareSnowflakes(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The order every history page is returned in: oldest first, id breaking ties. */
function compareChronological(a: HistoryPageRow, b: HistoryPageRow): number {
  return a.createdAt - b.createdAt || compareSnowflakes(a.id, b.id);
}

/**
 * Select one page of history and return it oldest first, by `createdAt` with
 * the id breaking ties.
 *
 * The cursor compares message ids (snowflakes, so later ids are greater), as
 * `before` always has. `latest` and `before` take the rows with the newest
 * `createdAt` on their side of the cursor.
 *
 * `after` takes the rows with the smallest ids past the cursor, so the page
 * is exactly the next ids after it and the following page, cut at the
 * greatest id in this one, neither skips nor repeats a row. Selecting by
 * `createdAt` would skip: a relayed message keeps its sender's `createdAt`
 * but is given a local id on arrival, so it can carry a later id than a
 * message it predates. The selected rows are then put in the common order.
 *
 * `select` runs the query for one table: it receives the cursor condition
 * (undefined for `latest`, so `and(scope, cursor)` drops it), the ordering and
 * the limit, and adds its own scope condition.
 */
export function selectHistoryPage<Row extends HistoryPageRow>(
  page: HistoryPage,
  columns: HistoryPageColumns,
  select: (cursor: SQL | undefined, orderBy: SQL[], limit: number) => Row[],
): Row[] {
  if (page.direction === 'after') {
    const rows = select(gt(columns.id, page.cursor), [asc(columns.id)], page.limit);
    return rows.sort(compareChronological);
  }
  const cursor = page.direction === 'before' ? lt(columns.id, page.cursor) : undefined;
  const rows = select(cursor, [desc(columns.createdAt), desc(columns.id)], page.limit);
  rows.reverse();
  return rows;
}

/**
 * Mark a response as having honoured `after`. Called on every successful
 * forward page, the empty one included, because an empty page is only
 * meaningful to a client that knows the server read the cursor.
 */
export function markHistoryPageHonoured(reply: FastifyReply, page: HistoryPage): void {
  if (page.direction === 'after') {
    reply.header(MESSAGE_PAGING_HEADER, MESSAGE_PAGING_AFTER);
  }
}
