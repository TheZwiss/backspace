import { create } from 'zustand';
import type { DirectoryEntry } from '@backspace/shared';
import { api, HttpError } from '../api/client';
import { useInstanceStore, connectToInstance } from './instanceStore';
import { useExploreStore, type TaggedExploreSpace } from './exploreStore';
import { isAlreadyMemberError } from '../utils/joinErrors';

// ─── Types ──────────────────────────────────────────────────────────────────

/** The three ways a directory request can fail, as the section renders them. */
export type DirectoryFailure = 'disabled' | 'unreachable' | 'error';

export type DirectoryStatus = 'idle' | 'loading' | 'ok' | DirectoryFailure;

export type ConnectAndJoinResult =
  | { kind: 'joined'; spaceId: string; origin: string }
  | { kind: 'requested' }
  /** Nothing was typed and no cached session could be resumed: the dialog asks for the password. */
  | { kind: 'needs-password' }
  | { kind: 'needs-remote-password'; remoteUsername: string };

interface DirectoryState {
  /**
   * The feed as the proxy returned it. The origin dedupe against the
   * session's connections is applied where it is rendered
   * (`OuterSpaceSection`), so it follows the live instance list.
   */
  entries: DirectoryEntry[];
  status: DirectoryStatus;
  query: string;
  offset: number;
  hasMore: boolean;
  /**
   * Why the last `loadMore` brought nothing, or null when the last one
   * brought a page. It is kept apart from `status` on purpose: a failed
   * continuation says nothing about the entries already on screen, and
   * moving `status` off `ok` took the Show more button away with it, which
   * left the user no way to ask again.
   */
  loadMoreError: DirectoryFailure | null;

  /** Replace the list with the first page for `query`. */
  fetch: (query: string) => Promise<void>;
  /** Append the next page of the current query. No-op when there is none. */
  loadMore: () => Promise<void>;
  /**
   * The Outer Space continuation: establish a session on the entry's origin
   * with the home password, then join (public) or request to join (request).
   */
  connectAndJoin: (entry: DirectoryEntry, password: string, message?: string) => Promise<ConnectAndJoinResult>;
  /**
   * The fallback for an account that already exists on the entry's origin
   * with its own password: log in there explicitly, then the same join step.
   */
  loginAndJoin: (entry: DirectoryEntry, username: string, remotePassword: string, message?: string) => Promise<ConnectAndJoinResult>;
  reset: () => void;
}

/** Page size of the directory feed; the proxy and the hub use the same number. */
export const DIRECTORY_PAGE_SIZE = 50;

// ─── Helpers ────────────────────────────────────────────────────────────────

function statusForError(err: unknown): DirectoryFailure {
  if (err instanceof HttpError) {
    if (err.code === 'directory_disabled') return 'disabled';
    if (err.code === 'directory_unreachable') return 'unreachable';
  }
  return 'error';
}

function entryKey(entry: DirectoryEntry): string {
  return `${entry.origin}\n${entry.id}`;
}

/** Append `incoming` to `current`, dropping entries already present by (origin, id). */
function appendUnique(current: DirectoryEntry[], incoming: DirectoryEntry[]): DirectoryEntry[] {
  const seen = new Set(current.map(entryKey));
  const out = [...current];
  for (const entry of incoming) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function toExploreSpace(entry: DirectoryEntry): TaggedExploreSpace {
  return { ...entry, _instanceOrigin: entry.origin, joined: false };
}

// ─── Store ──────────────────────────────────────────────────────────────────

const initialState = {
  entries: [] as DirectoryEntry[],
  status: 'idle' as DirectoryStatus,
  query: '',
  offset: 0,
  hasMore: false,
  loadMoreError: null as DirectoryFailure | null,
};

export const useDirectoryStore = create<DirectoryState>((set, get) => {
  // Sequence number of the most recent fetch, so a slow reply for an older
  // query cannot overwrite the page of a newer one.
  let fetchSeq = 0;

  /**
   * Whether a continuation is already running.
   *
   * Show more has no in-flight state of its own, so two clicks in the same
   * page called `loadMore` twice, and both read the same `offset` because
   * neither had written it yet: two requests for one page, and the second
   * appended nothing. That second answer is indistinguishable from the
   * proxy's clamped page at the offset cap, so the rule that ends the feed
   * on a page that appends nothing took Show more away with pages still to
   * come. One continuation at a time is what makes that rule safe.
   */
  let loadingMore = false;

  /**
   * The join step both connect actions share. Runs once the origin has a
   * session: the space is joined or requested, and the pending requests are
   * refreshed so the Inner card can show the right state. The origin's
   * entries leave Outer Space on their own: the section dedupes at render
   * against the instance list, which the connect step just added it to.
   */
  async function joinAfterConnect(entry: DirectoryEntry, message?: string): Promise<ConnectAndJoinResult> {
    const explore = useExploreStore.getState();
    const space = toExploreSpace(entry);
    let result: ConnectAndJoinResult;
    if (entry.visibility === 'request') {
      await explore.requestJoin(space, message);
      result = { kind: 'requested' };
    } else {
      try {
        await explore.publicJoin(space);
      } catch (err) {
        // A federated account that was in the space already: the space
        // arrives with the connection's ready payload, so this is a join.
        if (!isAlreadyMemberError(err)) throw err;
      }
      result = { kind: 'joined', spaceId: entry.id, origin: entry.origin };
    }

    await explore.fetchMyRequests();
    return result;
  }

  return {
    ...initialState,

    fetch: async (query: string) => {
      const seq = ++fetchSeq;
      set({ status: 'loading', query });
      try {
        const feed = await api.directory.list(query, DIRECTORY_PAGE_SIZE, 0);
        if (seq !== fetchSeq) return;
        set({
          entries: feed.spaces,
          status: 'ok',
          offset: 0,
          hasMore: feed.spaces.length === DIRECTORY_PAGE_SIZE,
          loadMoreError: null,
        });
      } catch (err) {
        if (seq !== fetchSeq) return;
        set({ entries: [], status: statusForError(err), offset: 0, hasMore: false, loadMoreError: null });
      }
    },

    loadMore: async () => {
      const { status, hasMore, query, offset } = get();
      if (status !== 'ok' || !hasMore || loadingMore) return;
      const seq = fetchSeq;
      const nextOffset = offset + DIRECTORY_PAGE_SIZE;
      loadingMore = true;
      set({ loadMoreError: null });
      try {
        const feed = await api.directory.list(query, DIRECTORY_PAGE_SIZE, nextOffset);
        if (seq !== fetchSeq) return;
        set((state) => {
          const entries = appendUnique(state.entries, feed.spaces);
          return {
            entries,
            offset: nextOffset,
            // A page that added nothing is the end of the feed, whatever its
            // length. Past the proxy's offset cap (1000) every further page
            // is the page at the cap again, so a full page of entries the
            // list already holds used to keep `hasMore` true and Show more
            // loading the same fifty spaces for as long as it was clicked.
            hasMore: entries.length > state.entries.length && feed.spaces.length === DIRECTORY_PAGE_SIZE,
          };
        });
      } catch (err) {
        if (seq !== fetchSeq) return;
        // `status` stays `ok`: what is on screen is still the feed, and the
        // Show more button is the only way to ask for the page again.
        set({ loadMoreError: statusForError(err) });
      } finally {
        // Including the two early returns above: a superseded continuation
        // still finished, and the flag is not the next one's to hold.
        loadingMore = false;
      }
    },

    connectAndJoin: async (entry, password, message) => {
      const outcome = await connectToInstance(entry.origin, password);
      // Both non-connected outcomes are handed back: the dialog decides what
      // to ask for. An empty password is how it offers a cached session a
      // chance before prompting at all.
      if (outcome.kind !== 'connected') return outcome;
      return joinAfterConnect(entry, message);
    },

    loginAndJoin: async (entry, username, remotePassword, message) => {
      await useInstanceStore.getState().loginToRemote(entry.origin, username, remotePassword);
      return joinAfterConnect(entry, message);
    },

    reset: () => {
      fetchSeq++;
      set({ ...initialState });
    },
  };
});
