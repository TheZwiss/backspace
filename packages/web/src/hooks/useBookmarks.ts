import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BookmarkKind } from '@backspace/shared/src/bookmarks';
import { describeError } from '../i18n/errors';
import { bookmarkConversationKey, selectIsBookmarked, useBookmarkStore } from '../stores/bookmarkStore';
import { isDmChannel, useSpaceStore } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';

/** Which bookmark table a conversation's messages are in. */
export function bookmarkKindOf(channelId: string): BookmarkKind {
  return isDmChannel(channelId) ? 'dm' : 'channel';
}

/**
 * Keeps the bookmarked messages of the open conversation read from the
 * instance that serves it. Mounted by the list; the read happens once per
 * conversation, and again after the instance's socket reconnects (`resync`
 * clears what was read).
 */
export function useBookmarkedConversation(channelId: string | null | undefined): void {
  const origin = useSpaceStore((s) => (channelId ? s.channelOriginMap.get(channelId) : undefined));
  const kind = channelId ? bookmarkKindOf(channelId) : null;
  // `origin` is '' for the page's own instance and undefined for a channel the
  // client does not know; only the second has nothing to read.
  const loaded = useBookmarkStore((s) => (
    origin !== undefined && channelId && kind ? s.loadedConversations.has(bookmarkConversationKey(origin, kind, channelId)) : true
  ));

  useEffect(() => {
    if (origin === undefined || !channelId || !kind || loaded) return;
    void useBookmarkStore.getState().loadConversation(origin, kind, channelId);
  }, [origin, channelId, kind, loaded]);
}

interface MessageBookmarkParams {
  /** The instance that serves the message: the origin of its channel ('' is the page's own instance). Undefined while unknown. */
  origin: string | undefined;
  channelId: string;
  messageId: string;
}

export interface MessageBookmark {
  bookmarked: boolean;
  /** A request for this message is in flight. */
  busy: boolean;
  /** Saves the message, or removes its bookmark; failures are shown as a toast. */
  toggle: () => Promise<void>;
}

/** The bookmark state of one message and the one action on it. */
export function useMessageBookmark({ origin, channelId, messageId }: MessageBookmarkParams): MessageBookmark {
  const { t } = useTranslation('bookmarks');
  const kind = bookmarkKindOf(channelId);
  const bookmarked = useBookmarkStore((s) => origin !== undefined && selectIsBookmarked(s, origin, kind, messageId));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const toggle = useCallback(async () => {
    if (origin === undefined || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const store = useBookmarkStore.getState();
    const removing = selectIsBookmarked(store, origin, kind, messageId);
    try {
      if (removing) await store.remove(origin, kind, channelId, messageId);
      else await store.add(origin, kind, messageId);
    } catch (err) {
      useUIStore.getState().addToast(
        t(removing ? 'toast.removeFailed' : 'toast.addFailed', { reason: describeError(err) }),
        'warning',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [origin, kind, channelId, messageId, t]);

  return { bookmarked, busy, toggle };
}
