import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Bookmark } from '@backspace/shared/src/bookmarks';
import { useBookmarkStore } from '../../stores/bookmarkStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { useJumpStore } from '../../stores/jumpStore';
import { useUIStore } from '../../stores/uiStore';
import { describeError } from '../../i18n/errors';
import { BookmarkRow } from './BookmarkRow';
import { authorKey, useBookmarkAuthors } from './useBookmarkAuthors';

/** The connected origins as one comparable string, so an unchanged set is an unchanged value. */
function connectedOriginsKey(instances: { origin: string; status: string }[]): string {
  return instances.filter((i) => i.status === 'connected').map((i) => i.origin).sort().join('\n');
}

interface BookmarkListProps {
  /** Called after a bookmark was opened, so the surface holding the list can close. */
  onOpened?: () => void;
}

interface Entry {
  origin: string;
  bookmark: Bookmark;
}

/**
 * The user's bookmarks from the page's own instance and every connected one,
 * newest saved first. Pages are read per instance; "show more" reads the next
 * page of each instance that has one. An instance that cannot be read is left
 * out without a message (the store logs it, and opening the window reads again).
 */
export function BookmarkList({ onOpened }: BookmarkListProps) {
  const { t } = useTranslation('bookmarks');
  const connectedKey = useInstanceStore((s) => connectedOriginsKey(s.instances));
  const origins = useMemo(() => ['', ...(connectedKey ? connectedKey.split('\n') : [])], [connectedKey]);
  const lists = useBookmarkStore((s) => s.lists);
  const authors = useBookmarkAuthors();
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    void useBookmarkStore.getState().loadList(origins);
  }, [origins]);

  const entries = useMemo(() => {
    const all: Entry[] = [];
    for (const origin of origins) {
      for (const bookmark of lists.get(origin)?.items ?? []) all.push({ origin, bookmark });
    }
    return all.sort((a, b) => b.bookmark.createdAt - a.bookmark.createdAt);
  }, [origins, lists]);

  const statuses = origins.map((origin) => lists.get(origin));
  const loading = statuses.some((list) => !list || list.status === 'loading') && entries.length === 0;
  const hasMore = statuses.some((list) => list?.status === 'loaded' && list.nextCursor !== null);
  const loadingMore = statuses.some((list) => list?.loadingMore);

  const open = useCallback((bookmark: Bookmark) => {
    const jumped = useJumpStore.getState().requestJump(
      bookmark.kind === 'dm' || !bookmark.spaceId
        ? { kind: 'dm', channelId: bookmark.channelId }
        : { kind: 'channel', spaceId: bookmark.spaceId, channelId: bookmark.channelId },
      bookmark.messageId,
    );
    if (jumped) onOpened?.();
  }, [onOpened]);

  const remove = useCallback(async (origin: string, bookmark: Bookmark) => {
    setRemoving((current) => new Set(current).add(bookmark.id));
    try {
      await useBookmarkStore.getState().remove(origin, bookmark.kind, bookmark.channelId, bookmark.messageId);
    } catch (err) {
      useUIStore.getState().addToast(t('toast.removeFailed', { reason: describeError(err) }), 'warning');
    } finally {
      setRemoving((current) => {
        const next = new Set(current);
        next.delete(bookmark.id);
        return next;
      });
    }
  }, [t]);

  const showMore = useCallback(() => {
    for (const origin of origins) void useBookmarkStore.getState().loadMore(origin);
  }, [origins]);

  if (loading) {
    return <div className="p-6 text-center text-[13px] text-txt-tertiary">{t('list.loading')}</div>;
  }

  return (
    <div className="flex flex-col">
      {entries.length === 0 && (
        <div className="p-8 text-center">
          <div className="text-[14px] text-txt-secondary">{t('list.empty')}</div>
          <div className="mt-1 text-[12px] text-txt-tertiary">{t('list.emptyHint')}</div>
        </div>
      )}
      {entries.map(({ origin, bookmark }) => (
        <BookmarkRow
          key={`${origin}:${bookmark.id}`}
          bookmark={bookmark}
          author={authors.get(authorKey(origin, bookmark.authorId))}
          removing={removing.has(bookmark.id)}
          onOpen={open}
          onRemove={(b) => { void remove(origin, b); }}
        />
      ))}
      {hasMore && (
        <button
          type="button"
          onClick={showMore}
          disabled={loadingMore}
          className="mx-3 my-3 py-2 rounded text-[13px] text-accent-primary hover:bg-interactive-hover disabled:opacity-50 transition-colors"
        >
          {loadingMore ? t('list.loading') : t('list.showMore')}
        </button>
      )}
    </div>
  );
}
