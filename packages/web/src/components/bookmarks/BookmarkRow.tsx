import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Bookmark } from '@backspace/shared/src/bookmarks';
import { Avatar } from '../ui/Avatar';
import { BookmarkIcon } from '../ui/BookmarkIcon';
import { useFormatters } from '../../i18n/formatters';
import { messageTextForPreview } from '../../utils/stickerMessages';
import type { BookmarkAuthor } from './useBookmarkAuthors';

interface BookmarkRowProps {
  bookmark: Bookmark;
  /** The author's live profile when the client knows it; the saved name is shown otherwise. */
  author: BookmarkAuthor | undefined;
  removing: boolean;
  onOpen: (bookmark: Bookmark) => void;
  onRemove: (bookmark: Bookmark) => void;
}

/** The host of an instance origin: the short name of where a bookmark lives. */
function instanceLabel(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * One bookmark: who wrote it, where (instance, space, channel), when, the text
 * as saved, its attachments by name, and what became of the original. The row
 * opens the original; the trailing button removes the bookmark.
 */
export const BookmarkRow = memo(function BookmarkRow({ bookmark, author, removing, onOpen, onRemove }: BookmarkRowProps) {
  const { t } = useTranslation('bookmarks');
  const f = useFormatters();
  const name = author?.displayName ?? bookmark.authorName;
  const place = [instanceLabel(bookmark.instanceOrigin), bookmark.spaceName, bookmark.channelName].filter(Boolean).join(' · ');
  const text = bookmark.content ? messageTextForPreview(bookmark.content) : '';
  const deleted = bookmark.status === 'deleted';

  return (
    <div className="group/bookmark relative flex items-start gap-3 px-3 py-3 hover:bg-interactive-hover transition-colors">
      <button
        type="button"
        onClick={() => onOpen(bookmark)}
        className="flex-1 min-w-0 flex items-start gap-3 text-left"
        aria-label={t('list.open', { name })}
      >
        <div className="flex-shrink-0 mt-0.5">
          <Avatar
            src={author?.avatar ?? undefined}
            name={name}
            size={36}
            user={author?.user}
            userId={author?.user.homeUserId ?? bookmark.authorId}
            avatarColor={author?.avatarColor ?? undefined}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-semibold text-txt-primary truncate">{name}</span>
            <span className="text-[11px] text-txt-tertiary flex-shrink-0">{f.formatDateTime(bookmark.messageCreatedAt)}</span>
          </div>
          <div className="text-[11px] text-txt-tertiary truncate">{place}</div>
          {bookmark.status !== 'ok' && (
            <div
              className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[11px] ${
                deleted ? 'bg-accent-rose/10 text-accent-rose' : 'bg-accent-amber/10 text-accent-amber'
              }`}
            >
              {t(`status.${bookmark.status}`)}
            </div>
          )}
          {text && (
            <div className="mt-1 text-[13px] text-txt-secondary leading-[1.4] line-clamp-4 whitespace-pre-wrap break-words">
              {text}
            </div>
          )}
          {bookmark.attachments.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {bookmark.attachments.map((attachment) => (
                <li key={attachment.id} className="flex items-center gap-1.5 text-[11px] text-txt-tertiary min-w-0">
                  <span className="truncate">{attachment.originalName}</span>
                  <span className="flex-shrink-0">{f.formatBytes(attachment.size)}</span>
                  {attachment.state === 'gone' && (
                    <span className="flex-shrink-0 text-accent-amber">{t('attachment.gone')}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={() => onRemove(bookmark)}
        disabled={removing}
        title={t('list.remove')}
        aria-label={t('list.remove')}
        className="flex-shrink-0 p-1.5 rounded text-accent-primary hover:bg-interactive-hover disabled:opacity-50 transition-colors"
      >
        <BookmarkIcon filled size={18} />
      </button>
    </div>
  );
});
