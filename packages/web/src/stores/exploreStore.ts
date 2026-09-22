import { create } from 'zustand';
import type { ExploreSpace, JoinRequest, SpaceWithChannelsAndMembers } from '@backspace/shared';
import { api } from '../api/client';
import i18n from '../i18n';
import { resolveAssetUrl } from '../utils/assetUrls';
import { hostOf } from '../utils/identity';
import { useInstanceStore, waitForAutoConnect } from './instanceStore';
import { useSpaceStore } from './spaceStore';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaggedExploreSpace extends ExploreSpace {
  _instanceOrigin: string; // '' = home instance
}

/**
 * A join request keyed by the instance it lives on. Space ids are local to
 * their instance, so a request is only identified by `(origin, spaceId)`;
 * `''` is the home instance, matching `TaggedExploreSpace`.
 */
export interface TaggedJoinRequest extends JoinRequest {
  _instanceOrigin: string;
}

/**
 * Why the last `fetchSpaces` has nothing to show, as a fact rather than as a
 * sentence.
 *
 * The store used to keep the English text it would have rendered, and the
 * Explore page printed it, so a reader in German, Russian or Chinese got
 * English at the one moment the page had nothing else to say. The words live
 * at the surface now, the same split the federation registry's reason codes
 * follow (`i18n/registryErrors.ts`): `none_answered` is a state with a
 * catalog entry of its own, and `failed` carries the cause so `describeError`
 * can say what the server said, in the reader's language, with the English
 * `error` text left as the last-resort fallback it already is.
 */
export type ExploreFetchFailure =
  /** Every client in the fan-out rejected: home and every connected instance. */
  | { kind: 'none_answered' }
  /** The fan-out could not be run at all. */
  | { kind: 'failed'; cause: unknown };

/** What one client answers the Explore fan-out with. */
type ExploreListResult = Awaited<ReturnType<typeof api.explore.list>>;

/**
 * One instance's slot in the fan-out, carrying its origin whether or not it
 * answered, so an unanswered instance can be named rather than counted.
 */
type AnsweredFanOut = { answered: true; origin: string; value: ExploreListResult };
type FanOutResult = AnsweredFanOut | { answered: false; origin: string };

interface ExploreState {
  spaces: TaggedExploreSpace[];
  myRequests: TaggedJoinRequest[];
  searchQuery: string;
  /**
   * The query `spaces` answers, recorded when a fan-out lands rather than
   * when it is asked for. `searchQuery` is the live search box and the fetch
   * behind it is debounced, so anything that describes the current result set
   * (the empty copy: nothing matched, against nothing to show) has to read
   * this one instead, or it states something about results that have not
   * arrived.
   */
  resultsQuery: string;
  isLoading: boolean;
  discoveryEnabled: boolean;
  totalAll: number;
  error: ExploreFetchFailure | null;
  /**
   * The origins whose client did not answer the fan-out that produced the
   * `spaces` above, `''` for home exactly as `_instanceOrigin` encodes it,
   * empty when every client answered. Written by the same `set` as `spaces`,
   * so a notice built from it can never describe a different fan-out than
   * the list beside it.
   *
   * Exclusive with `error: { kind: 'none_answered' }`: that branch publishes
   * no list, so it has nothing to qualify and leaves this empty. One
   * instance out of several is the case this exists for, which used to be
   * dropped on the floor and read, to anyone who knew a space was there, as
   * that space having been deleted.
   */
  unansweredOrigins: string[];

  fetchSpaces: (query?: string) => Promise<void>;
  fetchMyRequests: () => Promise<void>;
  publicJoin: (space: TaggedExploreSpace) => Promise<SpaceWithChannelsAndMembers>;
  requestJoin: (space: TaggedExploreSpace, message?: string) => Promise<JoinRequest>;
  setSearchQuery: (q: string) => void;
  reset: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * The client for the instance that owns a space. `''` is home. A space id
 * only means something on its own instance, so a remote origin the session
 * does not hold is an error, never a silent fall-through to home: the join
 * or request would land on the wrong instance with a foreign id.
 */
function getApiForOrigin(origin: string) {
  if (!origin) return api;
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  if (!instance) {
    throw new Error(i18n.t('spaces:explore.notConnected', { host: hostOf(origin) }));
  }
  return instance.api;
}

function getConnectedInstances() {
  return useInstanceStore.getState().instances.filter(i => i.status === 'connected');
}

// ─── Store ──────────────────────────────────────────────────────────────────

/**
 * Sequence number of the most recent `fetchSpaces`, so a slow reply for an
 * older query cannot overwrite the answer to a newer one. The same guard
 * `directoryStore` runs on the other half of the Explore page, and the page
 * needs both: one search box drives the two stores, and without this the
 * Inner list could settle on the previous query while Outer showed the
 * current one. The fan-out asks one client per instance in parallel, so its
 * duration is the slowest instance in the set, which is exactly when this
 * overtakes.
 *
 * There is one store per process, so the counter lives beside it rather than
 * in a factory closure. `reset()` bumps it too, so an in-flight fan-out is
 * orphaned whenever the store is cleared; nothing in the app calls `reset()`
 * today (`authStore.resetUserStores` does not include this store or
 * `directoryStore`), so that path is the tests' and whoever wires it later.
 */
let fetchSeq = 0;

/**
 * The same guard for the pending-requests fan-out, which needs one for the
 * same reason: on `main` it was a single call to home, and this branch made
 * it a `Promise.allSettled` over every connected instance, so it now lasts as
 * long as its slowest member and two of them can overtake. The page calls it
 * beside `fetchSpaces` on mount, on every search and on every change to the
 * connected set, and an overtaken answer leaves a card reading "Request
 * Pending" that is not, or missing one that is.
 */
let requestsSeq = 0;

export const useExploreStore = create<ExploreState>((set, get) => ({
  spaces: [],
  myRequests: [],
  searchQuery: '',
  resultsQuery: '',
  isLoading: false,
  discoveryEnabled: true,
  totalAll: 0,
  error: null,
  unansweredOrigins: [],

  fetchSpaces: async (query?: string) => {
    const seq = ++fetchSeq;
    set({ isLoading: true, error: null, unansweredOrigins: [] });

    await waitForAutoConnect();

    try {
      const connectedInstances = getConnectedInstances();

      // Home plus every connected remote instance, asked in parallel. Each
      // call settles into a tagged result instead of rejecting, so a client
      // that did not answer carries its own origin: `Promise.allSettled`
      // gives a rejected slot no identity beyond its index, and the page has
      // to name the host it could not reach.
      const fanOut: { origin: string; list: () => Promise<ExploreListResult> }[] = [
        { origin: '', list: () => api.explore.list(query) },
        ...connectedInstances.map(inst => ({
          origin: inst.origin,
          list: () => inst.api.explore.list(query),
        })),
      ];

      const results = await Promise.all(
        fanOut.map(({ origin, list }) =>
          list().then(
            (value): FanOutResult => ({ answered: true, origin, value }),
            (): FanOutResult => ({ answered: false, origin }),
          )
        ),
      );

      const fulfilled = results.filter((r): r is AnsweredFanOut => r.answered);
      const unansweredOrigins = results.filter(r => !r.answered).map(r => r.origin);

      // If ALL instances failed, surface an error
      if (fulfilled.length === 0 && unansweredOrigins.length > 0) {
        // A superseded fan-out says nothing, and leaves `isLoading` to the
        // one that superseded it: clearing it here would take the spinner off
        // a list that is still being fetched.
        if (seq !== fetchSeq) return;
        set({ isLoading: false, error: { kind: 'none_answered' } });
        return;
      }

      const allSpaces: TaggedExploreSpace[] = [];
      const seen = new Set<string>(); // dedup by spaceId+origin
      let homeDiscoveryEnabled = true;
      let totalAllSum = 0;

      for (const { origin, value } of fulfilled) {
        const { spaces, discoveryEnabled, totalAll } = value;

        // Track home instance discovery state
        if (!origin) {
          homeDiscoveryEnabled = discoveryEnabled;
        }

        totalAllSum += totalAll ?? 0;

        for (const space of spaces) {
          const key = `${space.id}:${origin}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (origin && space.icon) {
            space.icon = resolveAssetUrl(space.icon, origin) ?? space.icon;
          }
          if (origin && space.banner) {
            space.banner = resolveAssetUrl(space.banner, origin) ?? space.banner;
          }
          allSpaces.push({ ...space, _instanceOrigin: origin, joined: space.joined ?? false });
        }
      }

      if (seq !== fetchSeq) return;
      set({
        spaces: allSpaces,
        resultsQuery: query ?? '',
        discoveryEnabled: homeDiscoveryEnabled,
        totalAll: totalAllSum,
        unansweredOrigins,
        isLoading: false,
      });
    } catch (err) {
      if (seq !== fetchSeq) return;
      set({ isLoading: false, error: { kind: 'failed', cause: err } });
    }
  },

  fetchMyRequests: async () => {
    const seq = ++requestsSeq;
    await waitForAutoConnect();

    // Pending requests live on the instance that owns the space, so ask home
    // plus every connected instance and tag each result with its origin. A
    // rejected client only drops its own rows: allSettled keeps the rest.
    const connectedInstances = getConnectedInstances();

    const results = await Promise.allSettled([
      api.explore.myJoinRequests('pending').then(res => ({ requests: res.requests, origin: '' })),
      ...connectedInstances.map(inst =>
        inst.api.explore.myJoinRequests('pending').then(res => ({ requests: res.requests, origin: inst.origin }))
      ),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ requests: JoinRequest[]; origin: string }> => r.status === 'fulfilled'
    );

    // Nothing answered: keep what we have rather than blanking a list the
    // cards are already showing. This is non-critical state, so no error.
    if (fulfilled.length === 0) return;
    // Superseded: a later fan-out has already asked, and its answer is the
    // one the page should end up with.
    if (seq !== requestsSeq) return;

    const myRequests: TaggedJoinRequest[] = [];
    for (const { value } of fulfilled) {
      for (const request of value.requests) {
        myRequests.push({ ...request, _instanceOrigin: value.origin });
      }
    }

    set({ myRequests });
  },

  publicJoin: async (space: TaggedExploreSpace) => {
    const client = getApiForOrigin(space._instanceOrigin);
    const fullSpace = await client.explore.publicJoin(space.id);

    // Add to space store
    useSpaceStore.getState().addSpaceFromReady(space._instanceOrigin, fullSpace);

    // Mark as joined in explore list
    set((state) => ({
      spaces: state.spaces.map(s =>
        s.id === space.id && s._instanceOrigin === space._instanceOrigin
          ? { ...s, joined: true }
          : s
      ),
    }));

    return fullSpace;
  },

  requestJoin: async (space: TaggedExploreSpace, message?: string) => {
    const client = getApiForOrigin(space._instanceOrigin);
    const request = await client.explore.requestJoin(space.id, message);

    set((state) => ({
      myRequests: [...state.myRequests, { ...request, _instanceOrigin: space._instanceOrigin }],
    }));

    return request;
  },

  setSearchQuery: (q: string) => set({ searchQuery: q }),

  reset: () => {
    // Orphan whatever is in flight: its answer belongs to the state this
    // call is clearing.
    fetchSeq++;
    requestsSeq++;
    set({
      spaces: [],
      myRequests: [],
      searchQuery: '',
      resultsQuery: '',
      isLoading: false,
      discoveryEnabled: true,
      totalAll: 0,
      error: null,
      unansweredOrigins: [],
    });
  },
}));
