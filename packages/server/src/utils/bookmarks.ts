import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, isNotNull, lt, ne, or } from 'drizzle-orm';
import type { ErrorCode } from '@backspace/shared/src/errors.js';
import {
  BOOKMARKS_PAGE_DEFAULT,
  BOOKMARKS_PAGE_MAX,
  type Bookmark,
  type BookmarkAttachment,
  type BookmarkKind,
  type BookmarkPage,
  type BookmarkStatus,
} from '@backspace/shared/src/bookmarks.js';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { deleteUploadFile } from './fileCleanup.js';
import { getOurOrigin } from './federationAuth.js';
import { hasPermission, isDmMember, PermissionBits } from './permissions.js';
import { generateSnowflake } from './snowflake.js';

/**
 * Personal bookmarks (docs/systems/bookmarks.md): a frozen copy of a message plus
 * the ids needed to open the original. Everything here runs on the instance that
 * serves the message; nothing is relayed.
 */

type Db = ReturnType<typeof getDb>;

/** What the lifecycle helpers need; both the database and a transaction have it. */
type BookmarkDb = Pick<Db, 'select' | 'delete'>;

type BookmarkRow = typeof schema.messageBookmarks.$inferSelect;
type BookmarkAttachmentRow = typeof schema.bookmarkAttachments.$inferSelect;
type BookmarkAttachmentInsert = typeof schema.bookmarkAttachments.$inferInsert;
type SourceAttachmentRow = typeof schema.attachments.$inferSelect;

/** Reading a conversation takes the same permissions as the history routes (`routes/messages.ts`). */
const READ_PERMISSIONS = PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY;

/** The name saved for an author whose account no longer exists. */
const DELETED_USER_NAME = 'Deleted User';

// ─── The original message ─────────────────────────────────────────────────────

interface SourceMessage {
  kind: BookmarkKind;
  messageId: string;
  channelId: string;
  /** Null for a DM. */
  spaceId: string | null;
  authorId: string;
  content: string | null;
  type: string;
  createdAt: number;
}

function loadSourceMessage(db: Db, kind: BookmarkKind, messageId: string): SourceMessage | undefined {
  if (kind === 'channel') {
    const row = db.select({
      id: schema.messages.id,
      channelId: schema.messages.channelId,
      spaceId: schema.channels.spaceId,
      userId: schema.messages.userId,
      content: schema.messages.content,
      type: schema.messages.type,
      createdAt: schema.messages.createdAt,
    })
      .from(schema.messages)
      .innerJoin(schema.channels, eq(schema.messages.channelId, schema.channels.id))
      .where(eq(schema.messages.id, messageId))
      .get();
    if (!row) return undefined;
    return {
      kind, messageId: row.id, channelId: row.channelId, spaceId: row.spaceId,
      authorId: row.userId, content: row.content, type: row.type, createdAt: row.createdAt,
    };
  }
  const row = db.select({
    id: schema.dmMessages.id,
    channelId: schema.dmMessages.dmChannelId,
    userId: schema.dmMessages.userId,
    content: schema.dmMessages.content,
    type: schema.dmMessages.type,
    createdAt: schema.dmMessages.createdAt,
  })
    .from(schema.dmMessages)
    .where(eq(schema.dmMessages.id, messageId))
    .get();
  if (!row) return undefined;
  return {
    kind, messageId: row.id, channelId: row.channelId, spaceId: null,
    authorId: row.userId, content: row.content, type: row.type, createdAt: row.createdAt,
  };
}

/**
 * Whether `userId` can read the conversation a message is in right now. The
 * caller is a row id on this instance, so a federated account is judged by its
 * own row here.
 */
function canReadConversation(kind: BookmarkKind, channelId: string, spaceId: string | null, userId: string): boolean {
  if (kind === 'dm') return isDmMember(channelId, userId);
  if (spaceId === null) return false;
  return hasPermission(userId, spaceId, READ_PERMISSIONS, channelId);
}

interface NamedUser {
  username: string;
  displayName: string | null;
  isDeleted: number | null;
}

function displayNameOf(user: NamedUser | undefined): string {
  if (!user || user.isDeleted === 1) return DELETED_USER_NAME;
  return user.displayName ?? user.username;
}

/** Where the message was written, as names: the space and channel, or for a DM its group name or the other members. */
function conversationNames(db: Db, source: SourceMessage, userId: string): { spaceName: string | null; channelName: string | null } {
  if (source.kind === 'channel') {
    const row = db.select({ spaceName: schema.spaces.name, channelName: schema.channels.name })
      .from(schema.channels)
      .innerJoin(schema.spaces, eq(schema.channels.spaceId, schema.spaces.id))
      .where(eq(schema.channels.id, source.channelId))
      .get();
    return { spaceName: row?.spaceName ?? null, channelName: row?.channelName ?? null };
  }
  const channel = db.select({ name: schema.dmChannels.name })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, source.channelId))
    .get();
  const groupName = channel?.name?.trim();
  if (groupName) return { spaceName: null, channelName: groupName };
  const others = db.select({
    username: schema.users.username,
    displayName: schema.users.displayName,
    isDeleted: schema.users.isDeleted,
  })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(and(eq(schema.dmMembers.dmChannelId, source.channelId), ne(schema.dmMembers.userId, userId)))
    .all();
  return { spaceName: null, channelName: others.map(displayNameOf).join(', ') || null };
}

function loadSourceAttachments(db: Db, source: SourceMessage): SourceAttachmentRow[] {
  const owner = source.kind === 'channel'
    ? eq(schema.attachments.messageId, source.messageId)
    : eq(schema.attachments.dmMessageId, source.messageId);
  return db.select().from(schema.attachments)
    .where(owner)
    .orderBy(schema.attachments.createdAt, schema.attachments.id)
    .all();
}

// ─── Attachments ──────────────────────────────────────────────────────────────

/**
 * The rows saved for the attachments of a message being bookmarked. The one
 * place that decides what a bookmark keeps of a file: today the metadata and the
 * name of the original's file (`copy_status = 'reference'`), with no copy of the
 * file. Keeping a copy is a change to this function (copy the file and its
 * thumbnail, fill `filename` / `thumbnail_filename`, set 'copied') plus a one-off
 * pass over existing rows; the table, the API and every reader already handle it.
 */
export function snapshotBookmarkAttachments(bookmarkId: string, attachments: SourceAttachmentRow[]): BookmarkAttachmentInsert[] {
  return attachments.map((attachment, position) => ({
    id: generateSnowflake(),
    bookmarkId,
    position,
    originalName: attachment.originalName,
    mimetype: attachment.mimetype,
    size: attachment.size,
    width: attachment.width,
    height: attachment.height,
    duration: attachment.duration,
    playable: attachment.playable,
    sourceFilename: attachment.filename,
    sourceThumbnailFilename: attachment.thumbnailFilename,
    filename: null,
    thumbnailFilename: null,
    copyStatus: 'reference' as const,
  }));
}

function uploadExists(filename: string | null): boolean {
  if (!filename) return false;
  return fs.existsSync(path.join(config.uploadDir, path.basename(filename)));
}

/**
 * The file an attachment shows and whether it can still be shown: the bookmark's
 * own copy when it has one, else the original's file while that exists.
 */
function resolveAttachment(row: BookmarkAttachmentRow): BookmarkAttachment {
  const ownCopy = row.copyStatus === 'copied' && row.filename ? row.filename : null;
  const filename = ownCopy ?? row.sourceFilename;
  const thumbnail = ownCopy ? row.thumbnailFilename : row.sourceThumbnailFilename;
  const available = uploadExists(filename);
  return {
    id: row.id,
    originalName: row.originalName,
    mimetype: row.mimetype,
    size: row.size,
    width: row.width,
    height: row.height,
    duration: row.duration,
    playable: row.playable,
    state: available ? 'available' : 'gone',
    filename: available ? filename : null,
    thumbnailFilename: available && thumbnail && uploadExists(thumbnail) ? thumbnail : null,
  };
}

// ─── Reading ──────────────────────────────────────────────────────────────────

interface LiveMessage {
  channelId: string;
  spaceId: string | null;
  content: string | null;
}

/** The originals of `rows` that still exist, keyed `kind:messageId`. One query per table. */
function loadLiveMessages(db: Db, rows: BookmarkRow[]): Map<string, LiveMessage> {
  const live = new Map<string, LiveMessage>();
  const channelIds = rows.filter((row) => row.kind === 'channel').map((row) => row.messageId);
  if (channelIds.length > 0) {
    const found = db.select({
      id: schema.messages.id,
      channelId: schema.messages.channelId,
      spaceId: schema.channels.spaceId,
      content: schema.messages.content,
    })
      .from(schema.messages)
      .innerJoin(schema.channels, eq(schema.messages.channelId, schema.channels.id))
      .where(inArray(schema.messages.id, channelIds))
      .all();
    for (const row of found) {
      live.set(`channel:${row.id}`, { channelId: row.channelId, spaceId: row.spaceId, content: row.content });
    }
  }
  const dmIds = rows.filter((row) => row.kind === 'dm').map((row) => row.messageId);
  if (dmIds.length > 0) {
    const found = db.select({
      id: schema.dmMessages.id,
      channelId: schema.dmMessages.dmChannelId,
      content: schema.dmMessages.content,
    })
      .from(schema.dmMessages)
      .where(inArray(schema.dmMessages.id, dmIds))
      .all();
    for (const row of found) {
      live.set(`dm:${row.id}`, { channelId: row.channelId, spaceId: null, content: row.content });
    }
  }
  return live;
}

/**
 * Turn stored rows into what the API returns: the saved copy plus what became of
 * the original and of each attachment's file. Computed on every read, never
 * stored. `unavailable` carries no live data, only the fact.
 */
export function resolveBookmarks(userId: string, rows: BookmarkRow[]): Bookmark[] {
  if (rows.length === 0) return [];
  const db = getDb();
  const live = loadLiveMessages(db, rows);

  const attachmentsByBookmark = new Map<string, BookmarkAttachmentRow[]>();
  const attachmentRows = db.select().from(schema.bookmarkAttachments)
    .where(inArray(schema.bookmarkAttachments.bookmarkId, rows.map((row) => row.id)))
    .orderBy(schema.bookmarkAttachments.position)
    .all();
  for (const attachment of attachmentRows) {
    const list = attachmentsByBookmark.get(attachment.bookmarkId);
    if (list) list.push(attachment);
    else attachmentsByBookmark.set(attachment.bookmarkId, [attachment]);
  }

  const readable = new Map<string, boolean>();
  const canRead = (kind: BookmarkKind, message: LiveMessage): boolean => {
    const key = `${kind}:${message.channelId}`;
    let allowed = readable.get(key);
    if (allowed === undefined) {
      allowed = canReadConversation(kind, message.channelId, message.spaceId, userId);
      readable.set(key, allowed);
    }
    return allowed;
  };

  return rows.map((row): Bookmark => {
    const message = live.get(`${row.kind}:${row.messageId}`);
    let status: BookmarkStatus;
    if (!message) status = 'deleted';
    else if (!canRead(row.kind, message)) status = 'unavailable';
    else status = (message.content ?? '') === (row.content ?? '') ? 'ok' : 'edited';
    return {
      id: row.id,
      kind: row.kind,
      messageId: row.messageId,
      channelId: row.channelId,
      spaceId: row.spaceId,
      content: row.content,
      authorId: row.authorId,
      authorName: row.authorName,
      spaceName: row.spaceName,
      channelName: row.channelName,
      instanceOrigin: row.instanceOrigin,
      messageCreatedAt: row.messageCreatedAt,
      createdAt: row.createdAt,
      attachments: (attachmentsByBookmark.get(row.id) ?? []).map(resolveAttachment),
      status,
    };
  });
}

/** Where a page of the list resumes: after the last row of the previous page. */
export interface BookmarkCursor {
  createdAt: number;
  id: string;
}

const CURSOR_PATTERN = /^(\d{1,16}):([A-Za-z0-9_-]{1,64})$/;

export function formatBookmarkCursor(row: Pick<BookmarkRow, 'createdAt' | 'id'>): string {
  return `${row.createdAt}:${row.id}`;
}

/** The cursor a client sent back, or null when the value is not one this server issues. */
export function parseBookmarkCursor(value: string): BookmarkCursor | null {
  const match = CURSOR_PATTERN.exec(value);
  if (!match) return null;
  return { createdAt: Number(match[1]), id: match[2] as string };
}

/** One page of the caller's bookmarks, newest first, keyset-paged on (created_at, id). */
export function listBookmarks(
  userId: string,
  options: { cursor?: BookmarkCursor | null; limit?: number } = {},
): BookmarkPage {
  const db = getDb();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? BOOKMARKS_PAGE_DEFAULT), 1), BOOKMARKS_PAGE_MAX);
  const cursor = options.cursor ?? null;
  const rows = db.select().from(schema.messageBookmarks)
    .where(and(
      eq(schema.messageBookmarks.userId, userId),
      cursor
        ? or(
          lt(schema.messageBookmarks.createdAt, cursor.createdAt),
          and(eq(schema.messageBookmarks.createdAt, cursor.createdAt), lt(schema.messageBookmarks.id, cursor.id)),
        )
        : undefined,
    ))
    .orderBy(desc(schema.messageBookmarks.createdAt), desc(schema.messageBookmarks.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: resolveBookmarks(userId, page),
    nextCursor: rows.length > limit && last ? formatBookmarkCursor(last) : null,
  };
}

/** Ids of the caller's bookmarked messages in one channel or DM: the "is bookmarked" state of an open conversation. */
export function listBookmarkedMessageIds(userId: string, kind: BookmarkKind, channelId: string): string[] {
  return getDb().select({ messageId: schema.messageBookmarks.messageId })
    .from(schema.messageBookmarks)
    .where(and(
      eq(schema.messageBookmarks.userId, userId),
      eq(schema.messageBookmarks.kind, kind),
      eq(schema.messageBookmarks.channelId, channelId),
    ))
    .all()
    .map((row) => row.messageId);
}

// ─── Creating ─────────────────────────────────────────────────────────────────

export type CreateBookmarkResult =
  | { ok: true; bookmark: Bookmark; created: boolean }
  | { ok: false; status: 400 | 404; code: ErrorCode };

/**
 * Bookmark a message for `userId`, or return the bookmark that is already there.
 * The caller must be able to read the message now; a message they cannot read is
 * answered like one that does not exist, so a request cannot probe for ids.
 */
export function createBookmark(userId: string, kind: BookmarkKind, messageId: string): CreateBookmarkResult {
  const db = getDb();
  const source = loadSourceMessage(db, kind, messageId);
  if (!source || !canReadConversation(kind, source.channelId, source.spaceId, userId)) {
    return { ok: false, status: 404, code: 'message_not_found' };
  }
  if (source.type === 'system') return { ok: false, status: 400, code: 'validation_failed' };

  const author = db.select({
    username: schema.users.username,
    displayName: schema.users.displayName,
    isDeleted: schema.users.isDeleted,
  }).from(schema.users).where(eq(schema.users.id, source.authorId)).get();
  const names = conversationNames(db, source, userId);
  const attachments = loadSourceAttachments(db, source);

  const outcome = db.transaction((tx) => {
    const existing = tx.select().from(schema.messageBookmarks)
      .where(and(
        eq(schema.messageBookmarks.userId, userId),
        eq(schema.messageBookmarks.kind, kind),
        eq(schema.messageBookmarks.messageId, source.messageId),
      ))
      .get();
    if (existing) return { row: existing, created: false };

    const row: BookmarkRow = {
      id: generateSnowflake(),
      userId,
      kind,
      messageId: source.messageId,
      channelId: source.channelId,
      spaceId: source.spaceId,
      content: source.content,
      authorId: source.authorId,
      authorName: displayNameOf(author),
      spaceName: names.spaceName,
      channelName: names.channelName,
      instanceOrigin: getOurOrigin(),
      messageCreatedAt: source.createdAt,
      createdAt: Date.now(),
    };
    tx.insert(schema.messageBookmarks).values(row).run();
    const attachmentRows = snapshotBookmarkAttachments(row.id, attachments);
    if (attachmentRows.length > 0) tx.insert(schema.bookmarkAttachments).values(attachmentRows).run();
    return { row, created: true };
  });

  const [bookmark] = resolveBookmarks(userId, [outcome.row]);
  if (!bookmark) throw new Error(`Bookmark ${outcome.row.id} could not be read back`);
  return { ok: true, bookmark, created: outcome.created };
}

// ─── Removing ─────────────────────────────────────────────────────────────────

/**
 * Delete files a bookmark owned: its own copies (`bookmark_attachments.filename`),
 * never `source_filename`, which belongs to the original message. Called with the
 * names read from the rows just removed, after the transaction that removed them
 * committed (a rolled-back row must keep its file). While files are not copied
 * there are none, so this deletes nothing today.
 */
export function deleteBookmarkFiles(filenames: string[]): void {
  for (const filename of filenames) deleteUploadFile(filename);
}

/**
 * Remove a bookmark and the files it owns. Idempotent: the removed bookmark's
 * channel id when one was removed, null when there was none.
 */
export function deleteBookmark(userId: string, kind: BookmarkKind, messageId: string): { channelId: string } | null {
  const db = getDb();
  let ownFiles: string[] = [];
  const removed = db.transaction((tx) => {
    const row = tx.select({ id: schema.messageBookmarks.id, channelId: schema.messageBookmarks.channelId })
      .from(schema.messageBookmarks)
      .where(and(
        eq(schema.messageBookmarks.userId, userId),
        eq(schema.messageBookmarks.kind, kind),
        eq(schema.messageBookmarks.messageId, messageId),
      ))
      .get();
    if (!row) return null;
    ownFiles = tx.select({ filename: schema.bookmarkAttachments.filename })
      .from(schema.bookmarkAttachments)
      .where(and(eq(schema.bookmarkAttachments.bookmarkId, row.id), isNotNull(schema.bookmarkAttachments.filename)))
      .all()
      .flatMap((attachment) => (attachment.filename ? [attachment.filename] : []));
    tx.delete(schema.bookmarkAttachments).where(eq(schema.bookmarkAttachments.bookmarkId, row.id)).run();
    tx.delete(schema.messageBookmarks).where(eq(schema.messageBookmarks.id, row.id)).run();
    return { channelId: row.channelId };
  });
  deleteBookmarkFiles(ownFiles);
  return removed;
}

/**
 * Remove every bookmark of `userId`, for `tombstoneUser` (the `users` row stays,
 * so the foreign-key cascade never fires). Runs inside the caller's transaction
 * and returns the names of the files the bookmarks owned, which the caller
 * deletes after it commits. Subqueries, not id lists: a user has no bookmark
 * limit, and a list would hit SQLite's bound-variable cap.
 */
export function purgeUserBookmarks(db: BookmarkDb, userId: string): string[] {
  const userBookmarkIds = db.select({ id: schema.messageBookmarks.id })
    .from(schema.messageBookmarks)
    .where(eq(schema.messageBookmarks.userId, userId));
  const ownFiles = db.select({ filename: schema.bookmarkAttachments.filename })
    .from(schema.bookmarkAttachments)
    .where(and(
      inArray(schema.bookmarkAttachments.bookmarkId, userBookmarkIds),
      isNotNull(schema.bookmarkAttachments.filename),
    ))
    .all()
    .flatMap((attachment) => (attachment.filename ? [attachment.filename] : []));
  db.delete(schema.bookmarkAttachments)
    .where(inArray(schema.bookmarkAttachments.bookmarkId, userBookmarkIds))
    .run();
  db.delete(schema.messageBookmarks).where(eq(schema.messageBookmarks.userId, userId)).run();
  return ownFiles;
}
