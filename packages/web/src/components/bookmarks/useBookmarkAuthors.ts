import { useMemo } from 'react';
import type { User } from '@backspace/shared';
import { useSpaceStore } from '../../stores/spaceStore';

/** An author as the client currently knows them. */
export interface BookmarkAuthor {
  user: User;
  displayName: string;
  avatar: string | null;
  avatarColor: User['avatarColor'];
}

/** Key of an author row: the instance that issued it, then the id it gave. */
export function authorKey(origin: string, authorId: string): string {
  return `${origin}\u0000${authorId}`;
}

/**
 * The people the client knows, looked up by the row id one instance gave them
 * (a bookmark names its author that way). Built from the user-view cache, so
 * a changed avatar or name shows in the list without a reload; an author the
 * cache has not seen is simply absent, and the row falls back to the saved name
 * and initials.
 */
export function useBookmarkAuthors(): ReadonlyMap<string, BookmarkAuthor> {
  const userViews = useSpaceStore((s) => s.userViews);
  return useMemo(() => {
    const index = new Map<string, BookmarkAuthor>();
    for (const entry of userViews.values()) {
      const { user } = entry;
      index.set(authorKey(entry.deliveredBy, user.id), {
        user,
        displayName: user.displayName ?? user.username,
        avatar: user.avatar,
        avatarColor: user.avatarColor,
      });
    }
    return index;
  }, [userViews]);
}
