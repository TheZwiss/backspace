import { create } from 'zustand';
import type { DiscoverUser } from '@backspace/shared';
import { api } from '../api/client';
import { useInstanceStore } from './instanceStore';
import { normalizeUserAssets } from '../utils/assetUrls';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaggedDiscoverUser extends DiscoverUser {
  _instanceOrigin: string; // '' = home instance
}

interface DiscoverState {
  users: TaggedDiscoverUser[];
  searchQuery: string;
  isLoading: boolean;
  total: number;
  error: string | null;

  fetchUsers: (query?: string) => Promise<void>;
  setSearchQuery: (q: string) => void;
  updateRelationship: (userId: string, origin: string, relationship: DiscoverUser['relationship'], requestId?: string) => void;
  removeUser: (userId: string) => void;
  reset: () => void;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useDiscoverStore = create<DiscoverState>((set) => ({
  users: [],
  searchQuery: '',
  isLoading: false,
  total: 0,
  error: null,

  fetchUsers: async (query?: string) => {
    set({ isLoading: true, error: null });

    // Wait for autoConnectAll to finish (same guard as exploreStore)
    if (!useInstanceStore.getState()._autoConnectDone) {
      await new Promise<void>((resolve) => {
        const unsub = useInstanceStore.subscribe((state) => {
          if (state._autoConnectDone) {
            unsub();
            resolve();
          }
        });
        if (useInstanceStore.getState()._autoConnectDone) {
          unsub();
          resolve();
        }
      });
    }

    try {
      const instances = useInstanceStore.getState().instances;
      const connectedInstances = instances.filter(i => i.status === 'connected');

      const results = await Promise.allSettled([
        api.social.discover(query).then(res => ({ ...res, origin: '' })),
        ...connectedInstances.map(inst =>
          inst.api.social.discover(query).then(res => ({ ...res, origin: inst.origin }))
        ),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ users: DiscoverUser[]; total: number; origin: string }>[];

      if (fulfilled.length === 0) {
        set({ isLoading: false, error: 'Failed to reach any instance for discovery' });
        return;
      }

      const allUsers: TaggedDiscoverUser[] = [];
      const seen = new Set<string>();
      let totalSum = 0;

      for (const result of fulfilled) {
        const { users, total, origin } = result.value;
        totalSum += total;

        for (const user of users) {
          const key = `${user.id}:${origin}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (origin) normalizeUserAssets(user as unknown as { avatar?: string | null; banner?: string | null }, origin);
          allUsers.push({ ...user, _instanceOrigin: origin });
        }
      }

      set({
        users: allUsers,
        total: totalSum,
        isLoading: false,
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to discover users',
      });
    }
  },

  setSearchQuery: (q: string) => set({ searchQuery: q }),

  updateRelationship: (userId: string, origin: string, relationship: DiscoverUser['relationship'], requestId?: string) => {
    set((state) => ({
      users: state.users.map(u =>
        u.id === userId && u._instanceOrigin === origin
          ? { ...u, relationship, ...(requestId !== undefined ? { requestId } : {}) }
          : u
      ),
    }));
  },

  removeUser: (userId: string) => {
    set((state) => ({
      users: state.users.filter(u => u.id !== userId),
      total: Math.max(0, state.total - state.users.filter(u => u.id === userId).length),
    }));
  },

  reset: () => set({
    users: [],
    searchQuery: '',
    isLoading: false,
    total: 0,
    error: null,
  }),
}));
