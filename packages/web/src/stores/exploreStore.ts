import { create } from 'zustand';
import type { ExploreSpace, JoinRequest, SpaceWithChannelsAndMembers } from '@backspace/shared';
import { api } from '../api/client';
import i18n from '../i18n';
import { resolveAssetUrl } from '../utils/assetUrls';
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

interface ExploreState {
  spaces: TaggedExploreSpace[];
  myRequests: TaggedJoinRequest[];
  searchQuery: string;
  isLoading: boolean;
  discoveryEnabled: boolean;
  totalAll: number;
  error: string | null;

  fetchSpaces: (query?: string) => Promise<void>;
  fetchMyRequests: () => Promise<void>;
  publicJoin: (space: TaggedExploreSpace) => Promise<SpaceWithChannelsAndMembers>;
  requestJoin: (space: TaggedExploreSpace, message?: string) => Promise<JoinRequest>;
  setSearchQuery: (q: string) => void;
  reset: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hostOf(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

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

export const useExploreStore = create<ExploreState>((set, get) => ({
  spaces: [],
  myRequests: [],
  searchQuery: '',
  isLoading: false,
  discoveryEnabled: true,
  totalAll: 0,
  error: null,

  fetchSpaces: async (query?: string) => {
    set({ isLoading: true, error: null });

    await waitForAutoConnect();

    try {
      const connectedInstances = getConnectedInstances();

      // Fetch from home + all connected remote instances in parallel
      const results = await Promise.allSettled([
        api.explore.list(query).then(res => ({ ...res, origin: '' })),
        ...connectedInstances.map(inst =>
          inst.api.explore.list(query).then(res => ({ ...res, origin: inst.origin }))
        ),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ spaces: ExploreSpace[]; total: number; totalAll?: number; discoveryEnabled: boolean; origin: string }>[];
      const rejected = results.filter(r => r.status === 'rejected');

      // If ALL instances failed, surface an error
      if (fulfilled.length === 0 && rejected.length > 0) {
        set({ isLoading: false, error: 'Failed to reach any instance for discovery' });
        return;
      }

      const allSpaces: TaggedExploreSpace[] = [];
      const seen = new Set<string>(); // dedup by spaceId+origin
      let homeDiscoveryEnabled = true;
      let totalAllSum = 0;

      for (const result of fulfilled) {
        const { spaces, discoveryEnabled, totalAll, origin } = result.value;

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

      set({
        spaces: allSpaces,
        discoveryEnabled: homeDiscoveryEnabled,
        totalAll: totalAllSum,
        isLoading: false,
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch spaces',
      });
    }
  },

  fetchMyRequests: async () => {
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

  reset: () => set({
    spaces: [],
    myRequests: [],
    searchQuery: '',
    isLoading: false,
    discoveryEnabled: true,
    totalAll: 0,
    error: null,
  }),
}));
