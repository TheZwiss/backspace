import { create } from 'zustand';
import { BOOKMARKS_PAGE_DEFAULT, type Bookmark, type BookmarkKind } from '@backspace/shared/src/bookmarks';
import { getApiForOrigin } from '../utils/crossStoreResolvers';

/**
 * The signed-in user's bookmarks (docs/systems/bookmarks.md), from every
 * connected instance.
 *
 * A bookmark lives on the instance that serves the message, for the user's row
 * there, and ids are issued per instance: everything here is keyed by origin
 * as well as by id. Two things are held:
 *
 * - `keys`: which messages the user has bookmarked, for the "is bookmarked"
 *   state of the message in front of them. Loaded one conversation at a time
 *   when it opens (`loadConversation`), never as the user's whole list: a user
 *   has no bookmark limit.
 * - `lists`: the bookmark list the window shows, per origin, paged newest
 *   first (`loadList`, `loadMore`).
 *
 * Sources: the REST answers to the user's own add and remove, and
 * `bookmark_added` / `bookmark_removed` from that instance's socket (`applyAdded`,
 * `applyRemoved`), which also keep a second tab in step.
 *
 * The store imports no other store (it reaches the instance through
 * `crossStoreResolvers`), so components and `useWebSocket` can use it without
 * import cycles.
 */

const SEP = '\u0000';

/** Key of one bookmarked message: the instance, the kind, then the message id. */
export function bookmarkKey(origin: string, kind: BookmarkKind, messageId: string): string {
  return `${origin}${SEP}${kind}${SEP}${messageId}`;
}

/** Key of one conversation whose bookmarked messages are loaded. */
export function bookmarkConversationKey(origin: string, kind: BookmarkKind, channelId: string): string {
  return `${origin}${SEP}${kind}${SEP}${channelId}`;
}

/**
 * True when an instance answered 404: it runs a version without bookmarks, so
 * it has none to show. That is not a failure of the list, and asking again
 * would not change the answer.
 */
function lacksBookmarks(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && err.status === 404;
}

function originOf(key: string): string {
  return key.slice(0, key.indexOf(SEP));
}

export type BookmarkListStatus = 'loading' | 'loaded' | 'error';

/** One instance's page(s) of the list. */
export interface BookmarkOriginList {
  items: readonly Bookmark[];
  /** The cursor of the next page; null when the last page has been read. */
  nextCursor: string | null;
  status: BookmarkListStatus;
  /** True while a page after the first is being read. */
  loadingMore: boolean;
}

interface BookmarkState {
  keys: ReadonlySet<string>;
  /** Conversations whose `keys` have been read from their instance. */
  loadedConversations: ReadonlySet<string>;
  lists: ReadonlyMap<string, BookmarkOriginList>;

  /** Read which messages of a conversation are bookmarked. A no-op once read; errors are logged. */
  loadConversation: (origin: string, kind: BookmarkKind, channelId: string) => Promise<void>;
  /** Save a message. Resolves to the bookmark; rejects with the API error. */
  add: (origin: string, kind: BookmarkKind, messageId: string) => Promise<Bookmark>;
  /** Remove a bookmark. Rejects with the API error. */
  remove: (origin: string, kind: BookmarkKind, channelId: string, messageId: string) => Promise<void>;
  /** Read the first page of each origin's list, replacing what was held. */
  loadList: (origins: readonly string[]) => Promise<void>;
  /** Read the next page of one origin's list. */
  loadMore: (origin: string) => Promise<void>;
  /** A bookmark this instance pushed (`bookmark_added`). */
  applyAdded: (origin: string, bookmark: Bookmark) => void;
  /** A removal this instance pushed (`bookmark_removed`). */
  applyRemoved: (origin: string, kind: BookmarkKind, channelId: string, messageId: string) => void;
  /** The socket to this instance reconnected: events may have been missed, read again on next use. */
  resync: (origin: string) => void;
  /** The instance is gone (removed or signed out of): drop what it said. */
  forgetOrigin: (origin: string) => void;
  reset: () => void;
}

/**
 * Changes that arrived for a conversation while its `keys` were being read.
 * The answer may have been read before or after them, so they are laid over it.
 */
const changedDuringLoad = new Map<string, Map<string, boolean>>();
/** The latest list read per origin; an answer for an older one is dropped. */
const listSeq = new Map<string, number>();
/** Bumped by `reset`, so an answer for the previous session is dropped. */
let sessionGeneration = 0;

function withKey(keys: ReadonlySet<string>, key: string, present: boolean): ReadonlySet<string> {
  if (keys.has(key) === present) return keys;
  const next = new Set(keys);
  if (present) next.add(key);
  else next.delete(key);
  return next;
}

function sameBookmark(a: Bookmark, kind: BookmarkKind, messageId: string): boolean {
  return a.kind === kind && a.messageId === messageId;
}

export const useBookmarkStore = create<BookmarkState>((set, get) => {
  /** Record a change for the conversation it belongs to, if that conversation is being read. */
  function noteChange(origin: string, kind: BookmarkKind, channelId: string, messageId: string, present: boolean): void {
    changedDuringLoad.get(bookmarkConversationKey(origin, kind, channelId))?.set(bookmarkKey(origin, kind, messageId), present);
  }

  function putList(origin: string, update: (list: BookmarkOriginList) => BookmarkOriginList): void {
    set((state) => {
      const list = state.lists.get(origin);
      if (!list) return state;
      const lists = new Map(state.lists);
      lists.set(origin, update(list));
      return { lists };
    });
  }

  async function readPage(origin: string, cursor: string | undefined): Promise<{ items: Bookmark[]; nextCursor: string | null }> {
    return getApiForOrigin(origin).bookmarks.list({ cursor, limit: BOOKMARKS_PAGE_DEFAULT });
  }

  return {
    keys: new Set(),
    loadedConversations: new Set(),
    lists: new Map(),

    loadConversation: async (origin, kind, channelId) => {
      const conversationKey = bookmarkConversationKey(origin, kind, channelId);
      if (get().loadedConversations.has(conversationKey) || changedDuringLoad.has(conversationKey)) return;
      const generation = sessionGeneration;
      changedDuringLoad.set(conversationKey, new Map());
      try {
        const ids = await getApiForOrigin(origin).bookmarks.keys(kind, channelId);
        if (generation !== sessionGeneration) return;
        const changes = changedDuringLoad.get(conversationKey) ?? new Map<string, boolean>();
        set((state) => {
          const keys = new Set(state.keys);
          for (const id of ids) keys.add(bookmarkKey(origin, kind, id));
          for (const [key, present] of changes) {
            if (present) keys.add(key);
            else keys.delete(key);
          }
          const loadedConversations = new Set(state.loadedConversations);
          loadedConversations.add(conversationKey);
          return { keys, loadedConversations };
        });
      } catch (err) {
        if (lacksBookmarks(err) && generation === sessionGeneration) {
          // An instance without bookmarks has none marked: remember that, so it is not asked on every open.
          set((state) => ({ loadedConversations: new Set(state.loadedConversations).add(conversationKey) }));
          return;
        }
        // Without the answer no message shows as bookmarked; the next open asks again.
        console.error('[bookmarks] could not read the bookmarked messages of a conversation:', err);
      } finally {
        changedDuringLoad.delete(conversationKey);
      }
    },

    add: async (origin, kind, messageId) => {
      const generation = sessionGeneration;
      const bookmark = await getApiForOrigin(origin).bookmarks.add(kind, messageId);
      if (generation === sessionGeneration) get().applyAdded(origin, bookmark);
      return bookmark;
    },

    remove: async (origin, kind, channelId, messageId) => {
      const generation = sessionGeneration;
      await getApiForOrigin(origin).bookmarks.remove(kind, messageId);
      if (generation === sessionGeneration) get().applyRemoved(origin, kind, channelId, messageId);
    },

    loadList: async (origins) => {
      const generation = sessionGeneration;
      await Promise.all(origins.map(async (origin) => {
        const seq = (listSeq.get(origin) ?? 0) + 1;
        listSeq.set(origin, seq);
        set((state) => {
          const lists = new Map(state.lists);
          const previous = state.lists.get(origin);
          lists.set(origin, { items: previous?.items ?? [], nextCursor: previous?.nextCursor ?? null, status: 'loading', loadingMore: false });
          return { lists };
        });
        try {
          const page = await readPage(origin, undefined);
          if (generation !== sessionGeneration || listSeq.get(origin) !== seq) return;
          putList(origin, () => ({ items: page.items, nextCursor: page.nextCursor, status: 'loaded', loadingMore: false }));
        } catch (err) {
          if (generation !== sessionGeneration || listSeq.get(origin) !== seq) return;
          if (lacksBookmarks(err)) {
            putList(origin, () => ({ items: [], nextCursor: null, status: 'loaded', loadingMore: false }));
            return;
          }
          console.error('[bookmarks] could not read the list of an instance:', err);
          putList(origin, (list) => ({ ...list, status: 'error', loadingMore: false }));
        }
      }));
    },

    loadMore: async (origin) => {
      const list = get().lists.get(origin);
      if (!list || list.status !== 'loaded' || list.loadingMore || list.nextCursor === null) return;
      const generation = sessionGeneration;
      const seq = listSeq.get(origin) ?? 0;
      putList(origin, (current) => ({ ...current, loadingMore: true }));
      try {
        const page = await readPage(origin, list.nextCursor);
        if (generation !== sessionGeneration || listSeq.get(origin) !== seq) return;
        putList(origin, (current) => {
          const known = new Set(current.items.map((item) => item.id));
          return {
            ...current,
            items: [...current.items, ...page.items.filter((item) => !known.has(item.id))],
            nextCursor: page.nextCursor,
            loadingMore: false,
          };
        });
      } catch (err) {
        if (generation !== sessionGeneration || listSeq.get(origin) !== seq) return;
        console.error('[bookmarks] could not read the next page of a list:', err);
        putList(origin, (current) => ({ ...current, loadingMore: false }));
      }
    },

    applyAdded: (origin, bookmark) => {
      noteChange(origin, bookmark.kind, bookmark.channelId, bookmark.messageId, true);
      set((state) => {
        const keys = withKey(state.keys, bookmarkKey(origin, bookmark.kind, bookmark.messageId), true);
        const list = state.lists.get(origin);
        if (!list || list.items.some((item) => item.id === bookmark.id)) return keys === state.keys ? state : { keys };
        const lists = new Map(state.lists);
        lists.set(origin, { ...list, items: [bookmark, ...list.items] });
        return { keys, lists };
      });
    },

    applyRemoved: (origin, kind, channelId, messageId) => {
      noteChange(origin, kind, channelId, messageId, false);
      set((state) => {
        const keys = withKey(state.keys, bookmarkKey(origin, kind, messageId), false);
        const list = state.lists.get(origin);
        const items = list?.items.filter((item) => !sameBookmark(item, kind, messageId));
        if (!list || !items || items.length === list.items.length) return keys === state.keys ? state : { keys };
        const lists = new Map(state.lists);
        lists.set(origin, { ...list, items });
        return { keys, lists };
      });
    },

    resync: (origin) => {
      set((state) => {
        const loadedConversations = new Set([...state.loadedConversations].filter((key) => originOf(key) !== origin));
        const keys = new Set([...state.keys].filter((key) => originOf(key) !== origin));
        const lists = new Map(state.lists);
        lists.delete(origin);
        return { loadedConversations, keys, lists };
      });
    },

    forgetOrigin: (origin) => {
      listSeq.delete(origin);
      get().resync(origin);
    },

    reset: () => {
      sessionGeneration += 1;
      changedDuringLoad.clear();
      listSeq.clear();
      set({ keys: new Set(), loadedConversations: new Set(), lists: new Map() });
    },
  };
});

/** Whether the user has bookmarked this message, as far as the conversation's keys have been read. */
export function selectIsBookmarked(state: Pick<BookmarkState, 'keys'>, origin: string, kind: BookmarkKind, messageId: string): boolean {
  return state.keys.has(bookmarkKey(origin, kind, messageId));
}
