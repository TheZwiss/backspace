import { create } from 'zustand';
import type { ExploreSpace, JoinRequest, SpaceWithChannelsAndMembers } from '@backspace/shared';
import { api } from '../api/client';
import { resolveAssetUrl } from '../utils/assetUrls';
import { useInstanceStore } from './instanceStore';
import { useSpaceStore } from './spaceStore';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaggedExploreSpace extends ExploreSpace {
  _instanceOrigin: string; // '' = home instance
}

interface ExploreState {
  spaces: TaggedExploreSpace[];
  myRequests: JoinRequest[];
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

function getApiForOrigin(origin: string) {
  if (!origin) return api;
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  return instance?.api ?? api;
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

    // Wait for autoConnectAll to finish if it hasn't yet.
    // This prevents fetching with an incomplete/empty instance list on page reload.
    if (!useInstanceStore.getState()._autoConnectDone) {
      await new Promise<void>((resolve) => {
        const unsub = useInstanceStore.subscribe((state) => {
          if (state._autoConnectDone) {
            unsub();
            resolve();
          }
        });
        // Re-check after subscribing to avoid TOCTOU race
        if (useInstanceStore.getState()._autoConnectDone) {
          unsub();
          resolve();
        }
      });
    }

    try {
      const instances = useInstanceStore.getState().instances;
      const connectedInstances = instances.filter(i => i.status === 'connected');

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
    try {
      const { requests } = await api.explore.myJoinRequests('pending');
      set({ myRequests: requests });
    } catch {
      // Non-critical — silently fail
    }
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
      myRequests: [...state.myRequests, request],
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
