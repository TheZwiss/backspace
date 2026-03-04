import { create } from 'zustand';
import type { ExploreServer, JoinRequest, ServerWithChannelsAndMembers } from '@backspace/shared';
import { api } from '../api/client';
import { useInstanceStore } from './instanceStore';
import { useServerStore } from './serverStore';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaggedExploreServer extends ExploreServer {
  _instanceOrigin: string; // '' = home instance
}

interface ExploreState {
  servers: TaggedExploreServer[];
  myRequests: JoinRequest[];
  searchQuery: string;
  isLoading: boolean;
  discoveryEnabled: boolean;
  error: string | null;

  fetchServers: (query?: string) => Promise<void>;
  fetchMyRequests: () => Promise<void>;
  publicJoin: (server: TaggedExploreServer) => Promise<ServerWithChannelsAndMembers>;
  requestJoin: (server: TaggedExploreServer, message?: string) => Promise<JoinRequest>;
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
  servers: [],
  myRequests: [],
  searchQuery: '',
  isLoading: false,
  discoveryEnabled: true,
  error: null,

  fetchServers: async (query?: string) => {
    set({ isLoading: true, error: null });

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

      const allServers: TaggedExploreServer[] = [];
      const seen = new Set<string>(); // dedup by serverId+origin
      let homeDiscoveryEnabled = true;

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;

        const { servers, discoveryEnabled, origin } = result.value;

        // Track home instance discovery state
        if (!origin) {
          homeDiscoveryEnabled = discoveryEnabled;
        }

        for (const server of servers) {
          const key = `${server.id}:${origin}`;
          if (seen.has(key)) continue;
          seen.add(key);
          allServers.push({ ...server, _instanceOrigin: origin });
        }
      }

      set({
        servers: allServers,
        discoveryEnabled: homeDiscoveryEnabled,
        isLoading: false,
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch servers',
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

  publicJoin: async (server: TaggedExploreServer) => {
    const client = getApiForOrigin(server._instanceOrigin);
    const fullServer = await client.explore.publicJoin(server.id);

    // Add to server store
    useServerStore.getState().addServerFromReady(server._instanceOrigin, fullServer);

    // Remove from explore list
    set((state) => ({
      servers: state.servers.filter(s =>
        !(s.id === server.id && s._instanceOrigin === server._instanceOrigin)
      ),
    }));

    return fullServer;
  },

  requestJoin: async (server: TaggedExploreServer, message?: string) => {
    const client = getApiForOrigin(server._instanceOrigin);
    const request = await client.explore.requestJoin(server.id, message);

    set((state) => ({
      myRequests: [...state.myRequests, request],
    }));

    return request;
  },

  setSearchQuery: (q: string) => set({ searchQuery: q }),

  reset: () => set({
    servers: [],
    myRequests: [],
    searchQuery: '',
    isLoading: false,
    discoveryEnabled: true,
    error: null,
  }),
}));
