/**
 * Bookmarks: a user's personal copies of messages (docs/systems/bookmarks.md).
 * The wire shapes of `GET/PUT /api/bookmarks` and the limits both sides use.
 */

export const BOOKMARK_KINDS = ['channel', 'dm'] as const;

/** Where the original lives: a space channel (`messages`) or a DM (`dm_messages`). */
export type BookmarkKind = typeof BOOKMARK_KINDS[number];

/** Page size of `GET /api/bookmarks` when the request names none, and the most it allows. */
export const BOOKMARKS_PAGE_DEFAULT = 30;
export const BOOKMARKS_PAGE_MAX = 100;

/**
 * What became of the original, worked out each time the list is read:
 *  - `ok`: the original exists, with the text that was saved.
 *  - `edited`: the original exists but its text differs from the saved copy.
 *  - `deleted`: the original no longer exists (message, channel or space removed).
 *  - `unavailable`: the original exists but the reader can no longer see it.
 */
export type BookmarkStatus = 'ok' | 'edited' | 'deleted' | 'unavailable';

/**
 * Whether the file an attachment points at can still be shown: `available`, or
 * `gone` (deleted with its original message, and no copy of it was made).
 */
export type BookmarkAttachmentState = 'available' | 'gone';

export interface BookmarkAttachment {
  id: string;
  originalName: string;
  mimetype: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  playable: boolean | null;
  state: BookmarkAttachmentState;
  /** The file to draw: the bookmark's own copy when it has one, else the original's. Null when `state` is `gone`. */
  filename: string | null;
  thumbnailFilename: string | null;
}

export interface Bookmark {
  id: string;
  kind: BookmarkKind;
  /** The original's ids on the instance that serves it (`instanceOrigin`). */
  messageId: string;
  channelId: string;
  /** Null for a DM. */
  spaceId: string | null;
  /** The text as saved. Null for a message that had only attachments. */
  content: string | null;
  /** The author's row id on `instanceOrigin`, with the name as it was when saved. */
  authorId: string;
  authorName: string;
  spaceName: string | null;
  /** The channel's name, or for a DM the group name or the other members' names. */
  channelName: string | null;
  instanceOrigin: string;
  messageCreatedAt: number;
  createdAt: number;
  attachments: BookmarkAttachment[];
  status: BookmarkStatus;
}

export interface BookmarkPage {
  items: Bookmark[];
  /** Pass as `cursor` for the next page; null when this was the last. */
  nextCursor: string | null;
}
