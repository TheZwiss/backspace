/**
 * The message list's anchoring model: what the view is held to. Every path
 * that moves the list (opening a channel, a remount, a cache replaced under
 * the open view, a jump, Jump to Present, any size change of the content,
 * the viewport or the composer clearance) sets or re-applies one anchor.
 * See docs/systems/message-list.md, "Anchoring model".
 */

/**
 * `bottom`: the view follows the newest message.
 * `message`: the row with this id is held `offsetPx` below the top edge of
 * the scroll viewport (negative when the row starts above it).
 */
export type ScrollAnchor =
  | { kind: 'bottom' }
  | { kind: 'message'; messageId: string; offsetPx: number };

/**
 * Where a channel opens: a saved anchor, or the first unread message after
 * `lastReadId`, which needs the loaded messages to find.
 */
export type OpenTarget = ScrollAnchor | { kind: 'unread'; lastReadId: string };

export const BOTTOM_ANCHOR: ScrollAnchor = { kind: 'bottom' };

/**
 * A reading position saved earlier in this session wins. A view left at the
 * bottom was caught up, so newer messages since then open at the first
 * unread one. A channel without a read state opens at the latest message.
 */
export function resolveOpenTarget(saved: ScrollAnchor | undefined, lastReadId: string | undefined): OpenTarget {
  if (saved?.kind === 'message') return saved;
  if (lastReadId) return { kind: 'unread', lastReadId };
  return BOTTOM_ANCHOR;
}

function serverId(id: string): bigint | null {
  if (!/^\d+$/.test(id)) return null;
  return BigInt(id);
}

/**
 * The first message after the read position that someone else wrote, in
 * display order. Ids are snowflakes of the channel's own origin, the same
 * ids the read state and the server's around-query compare.
 */
export function firstUnreadMessageId<T extends { id: string }>(
  messages: readonly T[],
  lastReadId: string,
  isOwn: (message: T) => boolean,
): string | null {
  const lastRead = serverId(lastReadId);
  if (lastRead === null) return null;
  for (const message of messages) {
    const id = serverId(message.id);
    if (id === null || id <= lastRead) continue;
    if (isOwn(message)) continue;
    return message.id;
  }
  return null;
}

/**
 * True when the loaded page holds everything after the read position, so the
 * first unread message, if any, is in it: the page starts at or before the
 * read message, or there is nothing older to load.
 */
export function pageReachesReadPosition<T extends { id: string }>(
  messages: readonly T[],
  lastReadId: string,
  hasMore: boolean,
): boolean {
  if (!hasMore) return true;
  const lastRead = serverId(lastReadId);
  if (lastRead === null) return false;
  for (const message of messages) {
    const id = serverId(message.id);
    if (id !== null) return id <= lastRead;
  }
  return false;
}
