import { create } from 'zustand';
import type { Friend, FriendRequest, SendFriendRequest, User } from '@backspace/shared';
import { api, type BackspaceApiClient } from '../api/client';
import { getFriendsHomeOrigin, useInstanceStore, waitForAutoConnect } from './instanceStore';
import { normalizeUserAssets } from '../utils/assetUrls';
import { addressedTo } from '../utils/friendRequestTarget';
import { hostOf, isIssuedByHome, profileFieldsOf, updateIsAbout, updateIsAboutRowId, userKey, userUpdateReach, type IdentityFields, type PresenceSubject } from '../utils/identity';
import i18n from '../i18n';

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

/**
 * A friend or request action names rows of an instance the client no longer
 * holds a session for (it was removed from Connections). Refused rather than
 * sent to another instance: row ids mean nothing outside the instance that
 * issued them.
 */
export class SocialInstanceNotConnectedError extends Error {
  constructor(public readonly origin: string) {
    super(i18n.t('social:instanceNotConnected', { host: hostOf(origin) }));
    this.name = 'SocialInstanceNotConnectedError';
  }
}

/**
 * The client for the instance at `origin` (`''` is the page's own). An origin
 * the client holds no entry for throws `SocialInstanceNotConnectedError`; it
 * never falls back to the page's instance, which would act on whichever of
 * its own rows has the same id. Strict on purpose, unlike the shared
 * `getApiForOrigin` in `crossStoreResolvers.ts`, which other surfaces rely on
 * to fall back.
 */
function apiAt(origin: string): BackspaceApiClient {
  if (!origin) return api;
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  if (!instance) throw new SocialInstanceNotConnectedError(origin);
  return instance.api;
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

/** A user row is about the user it names: their home's row, a replicated row of them, or a native. */
function userRowRule<R extends IdentityFields & { _instanceOrigin: string }>(): PersonRule<R> {
  return {
    keyOf: (row) => userKey(row, row._instanceOrigin),
    isHomeView: (row) => isIssuedByHome(row, row._instanceOrigin),
  };
}

const friendRule = userRowRule<FriendRow>();
const searchRule = userRowRule<TaggedUser>();

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

/**
 * Matches the request row instance `origin` holds with id `id`, and, when
 * `other` (the other party as `origin` issued them) is given, every request
 * row with that person. The second half is for a caller whose request row may
 * not be in the list, such as a discover card loaded before the list reloaded.
 */
function isRequestWith(id: string, origin: string, other?: IdentityFields): (row: FriendRequestRow) => boolean {
  const key = other ? userKey(other, origin) : null;
  return (row) => isRowAt(row, id, origin) || (key !== null && requestRule.keyOf(row) === key);
}

/** Every instance's row an entry stands for. */
function rowsOf<R>(entry: ListEntry<R>): readonly R[] {
  return entry._rows ?? [entry];
}

/** `rows` grouped by person, each group in listing order, people in the order each was first listed. */
function groupByPerson<R>(rows: readonly R[], rule: PersonRule<R>): R[][] {
  const people = new Map<string, R[]>();
  for (const row of rows) {
    const key = rule.keyOf(row);
    const listed = people.get(key);
    if (listed) listed.push(row);
    else people.set(key, [row]);
  }
  return [...people.values()];
}

/** The row one person's rows are shown by: their home's own row when one is listed, else the first. */
function shownRow<R>(rows: readonly R[], rule: PersonRule<R>): NonNullable<R> {
  return (rows.find(rule.isHomeView) ?? rows[0])!;
}

/**
 * The entry for one person's rows. It is shown by `shownRow`, so its ids and
 * origin match the profile and discover cards.
 */
function entryOf<R>(rows: readonly R[], rule: PersonRule<R>): ListEntry<R> {
  const shown = shownRow(rows, rule);
  return rows.length === 1 ? shown : { ...shown, _rows: rows };
}

/** One entry per person for `rows`, in the order each person was first listed. */
function mergeRows<R>(rows: readonly R[], rule: PersonRule<R>): ListEntry<R>[] {
  return groupByPerson(rows, rule).map(listed => entryOf(listed, rule));
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

/**
 * `entries` without the rows `drop` matches; a person whose rows all go is
 * dropped, and one with rows left is shown by one of them. `entries` itself
 * when no row matched.
 */
function withoutRows<R>(entries: ListEntry<R>[], drop: (row: R) => boolean, rule: PersonRule<R>): ListEntry<R>[] {
  const rows = entries.flatMap(rowsOf);
  const kept = rows.filter(row => !drop(row));
  return kept.length === rows.length ? entries : mergeRows(kept, rule);
}

/** `entries` without the people any of whose rows `drop` matches; `entries` itself when none did. */
function withoutPeople<R>(entries: ListEntry<R>[], drop: (row: R) => boolean): ListEntry<R>[] {
  const kept = entries.filter(entry => !rowsOf(entry).some(drop));
  return kept.length === entries.length ? entries : kept;
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

// ─── Lookups for other modules ───────────────────────────────────────────────
// The `_rows` shape stays private to this file; other modules ask through these.

/** The friend row instance `origin` issued with id `id`, whichever entry holds it. */
export function friendRowAt(friends: readonly TaggedFriend[], id: string, origin: string): FriendRow | undefined {
  for (const entry of friends) {
    const row = rowsOf(entry).find(r => isRowAt(r, id, origin));
    if (row) return row;
  }
  return undefined;
}

/** The friend entry of the person `row` (issued by `origin`) names. */
export function friendEntryOf(friends: readonly TaggedFriend[], row: IdentityFields, origin: string): TaggedFriend | undefined {
  const key = userKey(row, origin);
  return friends.find(f => friendRule.keyOf(f) === key);
}

/**
 * The pending request row with the person `row` (issued by `origin`) names:
 * the row `origin` holds when it holds one, so its id is good on `origin`,
 * else the row their entry is shown by.
 */
export function pendingRequestWith(
  requests: readonly TaggedFriendRequest[],
  row: IdentityFields,
  origin: string,
): FriendRequestRow | undefined {
  const key = userKey(row, origin);
  const entry = requests.find(r => r.status === 'pending' && requestRule.keyOf(r) === key);
  if (!entry) return undefined;
  return rowsOf(entry).find(r => r._instanceOrigin === origin) ?? entry;
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
   * Send a friend request from the user's home (`getFriendsHomeOrigin`), the
   * only instance that accepts one from them. `target` is as the page's own
   * instance reads it: a typed handle is `{ username }`, a user the client
   * holds is named by `friendRequestTarget`. It is readdressed for the home
   * when that is another instance (`addressedTo`).
   */
  sendFriendRequest: (target: SendFriendRequest) => Promise<string | undefined>;
  /**
   * Accept or decline the request instance `origin` holds with id `id`, and
   * drop the person's request entry. `other` is the request's other party as
   * `origin` issued them, for a caller (a discover card) whose request may not
   * be in the list: the entry is then found by person.
   */
  updateFriendRequest: (id: string, origin: string, status: 'accepted' | 'declined', other?: IdentityFields) => Promise<void>;
  /** Cancel the request instance `origin` holds with id `id`; `other` as for `updateFriendRequest`. */
  cancelFriendRequest: (id: string, origin: string, other?: IdentityFields) => Promise<void>;
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
  /**
   * Drop every row instance `origin` issued, when its connection is
   * disconnected or removed. A person another instance also lists stays,
   * shown by that instance's row, so actions on them go there.
   */
  removeInstanceRows: (origin: string) => void;
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
      // Only the user's home accepts a request from them; a federated account
      // on any other instance is refused (`not_authoritative_for_sender`).
      const home = getFriendsHomeOrigin();
      const res = await apiAt(home).social.sendRequest(addressedTo(body, home));
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

  updateFriendRequest: async (id: string, origin: string, status: 'accepted' | 'declined', other?: IdentityFields) => {
    set({ isLoading: true, error: null });
    try {
      await apiAt(origin).social.updateRequest(id, status);

      // Drop the person's entry with every instance's row of the request:
      // the relay clears the other instances' rows, and reloading now would
      // race it.
      set((state) => ({
        requests: withoutPeople(state.requests, isRequestWith(id, origin, other)),
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

  cancelFriendRequest: async (id: string, origin: string, other?: IdentityFields) => {
    set({ isLoading: true, error: null });
    try {
      await apiAt(origin).social.cancelRequest(id);
      set((state) => ({
        requests: withoutPeople(state.requests, isRequestWith(id, origin, other)),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  removeFriend: async (row: IdentityFields, origin: string) => {
    const key = userKey(row, origin);
    const friend = friendEntryOf(get().friends, row, origin);
    if (!friend) return;
    set({ isLoading: true, error: null });
    try {
      await apiAt(friend._instanceOrigin).social.removeFriend(friend.id);
      set((state) => ({
        friends: withoutPeople(state.friends, f => friendRule.keyOf(f) === key),
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

      const rows: TaggedUser[] = [];
      results.forEach((result, i) => {
        if (result.status !== 'fulfilled') return;
        const origin = searches[i]!.origin;
        for (const user of result.value) {
          if (origin) normalizeUserAssets(user, origin);
          rows.push({ ...user, _instanceOrigin: origin });
          useSpaceStore.getState().upsertUserView(user, origin);
        }
      });

      // One result per person (`userKey`), the same rule as the friends and
      // requests lists: a person two instances return (their home's row and a
      // replicated row of them) is one result, shown by their home's row, and
      // two users native to different instances are two results whatever
      // their ids (#353).
      return groupByPerson(rows, searchRule).map(listed => shownRow(listed, searchRule));
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
    set((state) => {
      const friends = withoutPeople(state.friends, f => isRowAt(f, userId, origin));
      return friends === state.friends ? state : { friends };
    });
  },

  // Called from WS handler when a friend request is cancelled, declined or
  // its relay failed. The event names the request and the other party by the
  // ids of the instance that sent it, never another instance's rows.
  removeRequestById: (requestId: string, origin: string, userId?: string) => {
    set((state) => {
      const requests = withoutPeople(state.requests, r =>
        r._instanceOrigin === origin && (r.id === requestId || (userId !== undefined && r.user?.id === userId)));
      return requests === state.requests ? state : { requests };
    });
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
      if (friends === state.friends && requests === state.requests) return state;
      return { friends, requests };
    });
  },

  removeInstanceRows: (origin: string) => {
    set((state) => {
      const fromOrigin = (row: { _instanceOrigin: string }) => row._instanceOrigin === origin;
      const friends = withoutRows(state.friends, fromOrigin, friendRule);
      const requests = withoutRows(state.requests, fromOrigin, requestRule);
      if (friends === state.friends && requests === state.requests) return state;
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
