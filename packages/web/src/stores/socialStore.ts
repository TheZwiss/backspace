import { create } from 'zustand';
import type { Friend, FriendRequest, SendFriendRequest, User } from '@backspace/shared';
import { api } from '../api/client';
import { useInstanceStore, waitForAutoConnect } from './instanceStore';
import { normalizeUserAssets } from '../utils/assetUrls';
import { isIssuedByHome, profileFieldsOf, updateIsAbout, updateIsAboutRowId, userKey, userUpdateReach, type IdentityFields, type PresenceSubject } from '../utils/identity';

// ─── Tagged types (origin tracking for federation) ───────────────────────────

/** A friend row as one instance listed it. */
export type FriendRow = Friend & { _instanceOrigin: string };
/** A friend request row as one instance listed it. */
export type FriendRequestRow = FriendRequest & { _instanceOrigin: string };

/**
 * An entry of the friends or requests list: one person. Its own fields are
 * the row it is shown by (see `entryOf`). `_rows` holds every instance's row
 * of the person when more than one instance listed them, so an event from any
 * of those instances finds the entry; it is absent for a person only one
 * instance listed.
 */
export type ListEntry<R> = R & { _rows?: readonly R[] };

export type TaggedFriend = ListEntry<FriendRow>;
export type TaggedFriendRequest = ListEntry<FriendRequestRow>;
export type TaggedUser = User & { _instanceOrigin: string };

/**
 * Whether `request` was sent to the user. Its ids are the ids of the instance
 * that holds it, and `user` is the other party as that instance issued it, so
 * the request is incoming when the other party is its sender. Never compare
 * `fromId` with the session row's id: on any other instance that is someone
 * else's id.
 */
export function isIncomingRequest(request: FriendRequest): boolean {
  return !!request.user && request.user.id === request.fromId;
}

/** Whether the user sent `request`: the other party is its recipient (see `isIncomingRequest`). */
export function isOutgoingRequest(request: FriendRequest): boolean {
  return !!request.user && request.user.id === request.toId;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getApiForOrigin(origin: string) {
  if (!origin) return api;
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  return instance?.api ?? api;
}

// ─── One entry per person ────────────────────────────────────────────────────
// The friends and requests lists hold one entry per person (`userKey`), built
// from the rows every connected instance listed. Two rows are the same row
// only when the same instance issued them with the same id; an id alone names
// no one across instances (#353).

/** How a list names the person a row is about, and whether the row is their home's own view. */
interface PersonRule<R> {
  keyOf: (row: R) => string;
  isHomeView: (row: R) => boolean;
}

const friendRule: PersonRule<FriendRow> = {
  keyOf: (row) => userKey(row, row._instanceOrigin),
  isHomeView: (row) => isIssuedByHome(row, row._instanceOrigin),
};

/** A request is about its other party; a request without one is only ever itself. */
const requestRule: PersonRule<FriendRequestRow> = {
  keyOf: (row) => row.user
    ? userKey(row.user, row._instanceOrigin)
    : `request ${row._instanceOrigin} ${row.id}`,
  isHomeView: (row) => !!row.user && isIssuedByHome(row.user, row._instanceOrigin),
};

/** Whether `row` is the row instance `origin` issued with id `id`. */
function isRowAt(row: { id: string; _instanceOrigin: string }, id: string, origin: string): boolean {
  return row.id === id && row._instanceOrigin === origin;
}

/** Every instance's row an entry stands for. */
function rowsOf<R>(entry: ListEntry<R>): readonly R[] {
  return entry._rows ?? [entry];
}

/**
 * The entry for one person's rows. It is shown by their home's own row when
 * an instance listed it (its ids and origin match the profile and discover
 * cards), else by the first row listed.
 */
function entryOf<R>(rows: readonly R[], rule: PersonRule<R>): ListEntry<R> {
  const shown = rows.find(rule.isHomeView) ?? rows[0]!;
  return rows.length === 1 ? shown : { ...shown, _rows: rows };
}

/** One entry per person for `rows`, in the order each person was first listed. */
function mergeRows<R>(rows: readonly R[], rule: PersonRule<R>): ListEntry<R>[] {
  const people = new Map<string, R[]>();
  for (const row of rows) {
    const key = rule.keyOf(row);
    const listed = people.get(key);
    if (listed) listed.push(row);
    else people.set(key, [row]);
  }
  return [...people.values()].map(listed => entryOf(listed, rule));
}

/** `entries` with `row` added, or replacing the row the same instance issued with the same id. */
function withRow<R extends { id: string; _instanceOrigin: string }>(
  entries: readonly ListEntry<R>[],
  row: R,
  rule: PersonRule<R>,
): ListEntry<R>[] {
  let replaced = false;
  const rows = entries.flatMap(rowsOf).map((r) => {
    if (!isRowAt(r, row.id, row._instanceOrigin)) return r;
    replaced = true;
    return row;
  });
  return mergeRows(replaced ? rows : [...rows, row], rule);
}

/** `entries` without the rows `drop` matches; a person whose rows all go is dropped. */
function withoutRows<R>(entries: readonly ListEntry<R>[], drop: (row: R) => boolean, rule: PersonRule<R>): ListEntry<R>[] {
  return mergeRows(entries.flatMap(rowsOf).filter(row => !drop(row)), rule);
}

/** `entries` without the people any of whose rows `drop` matches. */
function withoutPeople<R>(entries: readonly ListEntry<R>[], drop: (row: R) => boolean): ListEntry<R>[] {
  return entries.filter(entry => !rowsOf(entry).some(drop));
}

/** `entries` with `update` applied to every row; `entries` itself when no row changed. */
function withEachRow<R>(entries: ListEntry<R>[], update: (row: R) => R, rule: PersonRule<R>): ListEntry<R>[] {
  let changed = false;
  const next = entries.map((entry) => {
    const rows = rowsOf(entry);
    const updated = rows.map(update);
    if (updated.every((row, i) => row === rows[i])) return entry;
    changed = true;
    return entryOf(updated, rule);
  });
  return changed ? next : entries;
}

// ─── Concurrency guards (module-level, not in store state) ──────────────────

let _friendsLoadInFlight = false;
let _requestsLoadInFlight = false;

// ─── Store ───────────────────────────────────────────────────────────────────

interface SocialState {
  friends: TaggedFriend[];
  requests: TaggedFriendRequest[];
  isLoading: boolean;
  error: string | null;
  loadFriends: () => Promise<void>;
  loadRequests: () => Promise<void>;
  /**
   * Send a friend request from the home instance. A typed handle is
   * `{ username }`; a user the client holds is named by `friendRequestTarget`.
   */
  sendFriendRequest: (target: SendFriendRequest) => Promise<string | undefined>;
  /** Accept or decline the request instance `origin` holds with id `id`. */
  updateFriendRequest: (id: string, origin: string, status: 'accepted' | 'declined') => Promise<void>;
  /** Cancel the request instance `origin` holds with id `id`. */
  cancelFriendRequest: (id: string, origin: string) => Promise<void>;
  /** Remove the friend `row` (issued by `origin`) is a row of, on the instance whose row the entry is shown by. */
  removeFriend: (row: IdentityFields, origin: string) => Promise<void>;
  searchUsers: (query: string) => Promise<TaggedUser[]>;
  addIncomingRequest: (request: FriendRequest, origin: string) => void;
  addOutboundRequest: (request: FriendRequest, origin: string) => void;
  addFriendFromAccepted: (friend: Friend, requestId: string, origin: string) => void;
  updateFriendPresence: (subject: PresenceSubject, origin: string, status: string) => void;
  /** Apply a `user_updated` row issued by `origin` to the friend rows it is about (`userUpdateReach`); profile fields only. */
  updateFriendProfile: (user: User, origin: string) => void;
  /** Drop the friend instance `origin` names by its row id `userId` (`friend_removed`). */
  removeFriendLocally: (userId: string, origin: string) => void;
  /**
   * Drop the request instance `origin` holds with id `requestId`, or with the
   * other party `userId` (that instance's row id), and with it the person's
   * rows from every other instance.
   */
  removeRequestById: (requestId: string, origin: string, userId?: string) => void;
  /** Drop the friends and pending requests the deleted user's `user_updated` row (issued by `origin`) is about (`updateIsAbout`). */
  removeDeletedUser: (user: IdentityFields, origin: string) => void;
  reset: () => void;
}

export const useSocialStore = create<SocialState>((set, get) => ({
  friends: [],
  requests: [],
  isLoading: false,
  error: null,

  loadFriends: async () => {
    if (_friendsLoadInFlight) return;
    _friendsLoadInFlight = true;
    set({ isLoading: true, error: null });
    try {
      // Wait for all remote connections to establish before fanning out
      await waitForAutoConnect();

      // Lazy import — avoids pulling spaceStore's transitive chain (voiceStore →
      // AudioManager) into test environments that mock only instanceStore.
      const { useSpaceStore } = await import('./spaceStore');

      const instances = useInstanceStore.getState().instances;
      const connectedInstances = instances.filter(i => i.status === 'connected');

      const results = await Promise.allSettled([
        api.social.friends().then(friends => ({ friends, origin: '' })),
        ...connectedInstances.map(inst =>
          inst.api.social.friends().then(friends => ({ friends, origin: inst.origin }))
        ),
      ]);

      // One entry per person (`userKey`): a friend two instances list (their
      // home's row and a replicated row of them) is one entry, and two people
      // native to different instances are two entries whatever their ids.
      const rows: FriendRow[] = [];
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { friends, origin } = result.value;
        for (const friend of friends) {
          if (origin) normalizeUserAssets(friend, origin);
          rows.push({ ...friend, _instanceOrigin: origin });
          // Friend carries all identity/avatar fields the cache needs; the
          // cache keeps the home's view when several instances deliver one.
          useSpaceStore.getState().upsertUserView(friend as unknown as User, origin);
        }
      }

      set({ friends: mergeRows(rows, friendRule), isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    } finally {
      _friendsLoadInFlight = false;
    }
  },

  loadRequests: async () => {
    if (_requestsLoadInFlight) return;
    _requestsLoadInFlight = true;
    set({ isLoading: true, error: null });
    try {
      // Wait for all remote connections to establish before fanning out
      await waitForAutoConnect();

      // Lazy import — same pattern as loadFriends; avoids AudioManager TDZ in tests.
      const { useSpaceStore } = await import('./spaceStore');

      const instances = useInstanceStore.getState().instances;
      const connectedInstances = instances.filter(i => i.status === 'connected');

      const results = await Promise.allSettled([
        api.social.requests().then(requests => ({ requests, origin: '' })),
        ...connectedInstances.map(inst =>
          inst.api.social.requests().then(requests => ({ requests, origin: inst.origin }))
        ),
      ]);

      // One entry per other party (`userKey`): a cross-instance request is a
      // row on each instance, and there is one pending request between two
      // people. The entry is shown by the row from the other party's home,
      // whose ids and origin line up with the discover and search cards and
      // the profile modal ("Request Pending").
      const rows: FriendRequestRow[] = [];
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { requests, origin } = result.value;
        for (const request of requests) {
          if (origin && request.user) normalizeUserAssets(request.user, origin);
          rows.push({ ...request, _instanceOrigin: origin });
          if (request.user) useSpaceStore.getState().upsertUserView(request.user, origin);
        }
      }

      set({ requests: mergeRows(rows, requestRule), isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    } finally {
      _requestsLoadInFlight = false;
    }
  },

  sendFriendRequest: async (target: SendFriendRequest) => {
    set({ isLoading: true, error: null });
    try {
      const body: SendFriendRequest = target.username === undefined
        ? target
        : { ...target, username: target.username.trim() };
      const res = await api.social.sendRequest(body);
      set({ isLoading: false });
      // Server emits friend_request_sent over WS; useWebSocket appends the row
      // optimistically. As a safety net for tabs that race the WS event, refresh
      // from server too.
      await get().loadRequests();
      return res.requestId;
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  updateFriendRequest: async (id: string, origin: string, status: 'accepted' | 'declined') => {
    set({ isLoading: true, error: null });
    try {
      await getApiForOrigin(origin).social.updateRequest(id, status);

      // Drop the person's entry with every instance's row of the request:
      // the relay clears the other instances' rows, and reloading now would
      // race it.
      set((state) => ({
        requests: withoutPeople(state.requests, r => isRowAt(r, id, origin)),
        isLoading: false,
      }));

      if (status === 'accepted') {
        await get().loadFriends();
      }
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  cancelFriendRequest: async (id: string, origin: string) => {
    set({ isLoading: true, error: null });
    try {
      await getApiForOrigin(origin).social.cancelRequest(id);
      set((state) => ({
        requests: withoutPeople(state.requests, r => isRowAt(r, id, origin)),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  removeFriend: async (row: IdentityFields, origin: string) => {
    const key = userKey(row, origin);
    const isThem = (f: FriendRow) => friendRule.keyOf(f) === key;
    const friend = get().friends.find(isThem);
    if (!friend) return;
    set({ isLoading: true, error: null });
    try {
      await getApiForOrigin(friend._instanceOrigin).social.removeFriend(friend.id);
      set((state) => ({
        friends: state.friends.filter(f => !isThem(f)),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  searchUsers: async (query: string) => {
    try {
      // Lazy import — avoids AudioManager TDZ in test environments.
      const { useSpaceStore } = await import('./spaceStore');

      const instances = useInstanceStore.getState().instances;
      const connectedInstances = instances.filter(i => i.status === 'connected');

      // Pair each promise with its origin for asset normalization
      const searches: { promise: Promise<User[]>; origin: string }[] = [
        { promise: api.social.search(query), origin: '' },
        ...connectedInstances.map(inst => ({
          promise: inst.api.social.search(query),
          origin: inst.origin,
        })),
      ];

      const results = await Promise.allSettled(searches.map(s => s.promise));

      const allUsers: TaggedUser[] = [];
      // Map canonical ID → index in allUsers for dedup with replacement
      const seen = new Map<string, number>();

      results.forEach((result, i) => {
        if (result.status !== 'fulfilled') return;
        const origin = searches[i]!.origin;
        for (const user of result.value) {
          // Deduplicate by canonical identity: replicated profiles share
          // the same homeUserId as the native profile's id, so collapse them.
          // Prefer native profiles (homeInstance is null) over replicated ones.
          // Note: homeUserId alone is NOT a native indicator — the server
          // backfills native users' homeUserId to their own id so federation
          // tier-1 lookups can find them. Only homeInstance distinguishes
          // native from replicated.
          const canonicalId = user.homeUserId ?? user.id;
          const isNative = !user.homeInstance;
          const existingIdx = seen.get(canonicalId);

          if (existingIdx !== undefined) {
            // Replace replicated with native when found
            if (isNative) {
              if (origin) normalizeUserAssets(user, origin);
              allUsers[existingIdx] = { ...user, _instanceOrigin: origin };
              useSpaceStore.getState().upsertUserView(user, origin);
            }
            continue;
          }

          seen.set(canonicalId, allUsers.length);
          if (origin) normalizeUserAssets(user, origin);
          allUsers.push({ ...user, _instanceOrigin: origin });
          useSpaceStore.getState().upsertUserView(user, origin);
        }
      });

      return allUsers;
    } catch (err) {
      console.error('Failed to search users:', err);
      return [];
    }
  },

  // Called from WS handler when another user sends you a friend request.
  // A row of a person already listed joins their entry.
  addIncomingRequest: (request: FriendRequest, origin: string) => {
    set((state) => ({ requests: withRow(state.requests, { ...request, _instanceOrigin: origin }, requestRule) }));
  },

  // Called from WS handler for multi-tab sync when this user creates an outbound request
  addOutboundRequest: (request: FriendRequest, origin: string) => {
    set((state) => ({ requests: withRow(state.requests, { ...request, _instanceOrigin: origin }, requestRule) }));
  },

  // Called from WS handler when someone accepts your friend request. The new
  // friend joins their entry if another instance listed them already, and
  // no pending request with them is left.
  addFriendFromAccepted: (friend: Friend, requestId: string, origin: string) => {
    set((state) => {
      const row: FriendRow = { ...friend, _instanceOrigin: origin };
      const key = friendRule.keyOf(row);
      return {
        friends: withRow(state.friends, row, friendRule),
        requests: withoutPeople(state.requests, r => isRowAt(r, requestId, origin) || requestRule.keyOf(r) === key),
      };
    });
  },

  // Called from WS handler when the other user removes us as a friend. The
  // friendship is one relationship however many instances list it, so the
  // person's entry goes; the relay clears the other instances' rows.
  removeFriendLocally: (userId: string, origin: string) => {
    set((state) => ({
      friends: withoutPeople(state.friends, f => isRowAt(f, userId, origin)),
    }));
  },

  // Called from WS handler when a friend request is cancelled, declined or
  // its relay failed. The event names the request and the other party by the
  // ids of the instance that sent it, never another instance's rows.
  removeRequestById: (requestId: string, origin: string, userId?: string) => {
    set((state) => ({
      requests: withoutPeople(state.requests, r =>
        r._instanceOrigin === origin && (r.id === requestId || (userId !== undefined && r.user?.id === userId))),
    }));
  },

  // A deletion reaches rows, not people: a deleted copy drops only that
  // instance's row, and the person's entry is then shown by another row.
  removeDeletedUser: (user: IdentityFields, origin: string) => {
    set((state) => {
      const friends = withoutRows(state.friends, f => updateIsAbout(f, f._instanceOrigin, user, origin), friendRule);
      const requests = withoutRows(state.requests, (r) => {
        const rowOrigin = r._instanceOrigin;
        if (r.user && updateIsAbout(r.user, rowOrigin, user, origin)) return true;
        return updateIsAboutRowId(r.fromId, rowOrigin, user, origin) || updateIsAboutRowId(r.toId, rowOrigin, user, origin);
      }, requestRule);
      const countRows = (entries: readonly ListEntry<unknown>[]) => entries.reduce((n, e) => n + rowsOf(e).length, 0);
      if (countRows(friends) === countRows(state.friends) && countRows(requests) === countRows(state.requests)) return state;
      return { friends, requests };
    });
  },

  // Called from WS handler on presence_update to keep friend status live.
  // Matched by the same key as activities (userKey), so a delivery from
  // any instance reaches the friend it is about and no other.
  updateFriendPresence: (subject: PresenceSubject, origin: string, status: string) => {
    const key = userKey(subject, origin);
    set((state) => {
      const friends = withEachRow(state.friends, f =>
        friendRule.keyOf(f) === key ? { ...f, status: status as Friend['status'] } : f, friendRule);
      return friends === state.friends ? state : { friends };
    });
  },

  // Called from WS handler on user_updated to keep friend profile data live
  updateFriendProfile: (user: User, origin: string) => {
    set((state) => {
      const friends = withEachRow(state.friends, f =>
        userUpdateReach(f, f._instanceOrigin, user, origin) ? { ...f, ...profileFieldsOf(user) } : f, friendRule);
      return friends === state.friends ? state : { friends };
    });
  },

  reset: () => set({ friends: [], requests: [], isLoading: false, error: null }),
}));
