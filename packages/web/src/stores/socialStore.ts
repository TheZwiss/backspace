import { create } from 'zustand';
import type { Friend, FriendRequest, User } from '@backspace/shared';
import { api } from '../api/client';
import { useInstanceStore } from './instanceStore';
import { normalizeUserAssets } from '../utils/assetUrls';

// ─── Federation errors ────────────────────────────────────────────────────

/** Thrown when the target domain has never been connected. */
export class InstanceNotConnectedError extends Error {
  constructor(public domain: string) {
    super(`Not connected to ${domain}`);
    this.name = 'InstanceNotConnectedError';
  }
}

/** Thrown when the instance entry exists but the session is disconnected/errored. */
export class InstanceDisconnectedError extends Error {
  constructor(public domain: string) {
    super(`Instance ${domain} is not currently connected`);
    this.name = 'InstanceDisconnectedError';
  }
}

// ─── Tagged types (origin tracking for federation) ───────────────────────────

export type TaggedFriend = Friend & { _instanceOrigin: string };
export type TaggedFriendRequest = FriendRequest & { _instanceOrigin: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getApiForOrigin(origin: string) {
  if (!origin) return api;
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  return instance?.api ?? api;
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface SocialState {
  friends: TaggedFriend[];
  requests: TaggedFriendRequest[];
  isLoading: boolean;
  error: string | null;
  loadFriends: () => Promise<void>;
  loadRequests: () => Promise<void>;
  sendFriendRequest: (username: string) => Promise<string | undefined>;
  updateFriendRequest: (id: string, status: 'accepted' | 'declined') => Promise<void>;
  cancelFriendRequest: (id: string) => Promise<void>;
  removeFriend: (id: string) => Promise<void>;
  searchUsers: (query: string) => Promise<User[]>;
  addIncomingRequest: (request: FriendRequest, origin: string) => void;
  addFriendFromAccepted: (friend: Friend, requestId: string, origin: string) => void;
  updateFriendPresence: (userId: string, status: string) => void;
  updateFriendProfile: (user: User) => void;
  removeFriendLocally: (userId: string, origin: string) => void;
  removeRequestById: (requestId: string, origin: string) => void;
  reset: () => void;
}

export const useSocialStore = create<SocialState>((set, get) => ({
  friends: [],
  requests: [],
  isLoading: false,
  error: null,

  loadFriends: async () => {
    set({ isLoading: true, error: null });
    try {
      const instances = useInstanceStore.getState().instances;
      const connectedInstances = instances.filter(i => i.status === 'connected');

      const results = await Promise.allSettled([
        api.social.friends().then(friends => ({ friends, origin: '' })),
        ...connectedInstances.map(inst =>
          inst.api.social.friends().then(friends => ({ friends, origin: inst.origin }))
        ),
      ]);

      const allFriends: TaggedFriend[] = [];
      const seen = new Set<string>();

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { friends, origin } = result.value;
        for (const friend of friends) {
          const key = `${friend.id}:${origin}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (origin) normalizeUserAssets(friend, origin);
          allFriends.push({ ...friend, _instanceOrigin: origin });
        }
      }

      set({ friends: allFriends, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  loadRequests: async () => {
    set({ isLoading: true, error: null });
    try {
      const instances = useInstanceStore.getState().instances;
      const connectedInstances = instances.filter(i => i.status === 'connected');

      const results = await Promise.allSettled([
        api.social.requests().then(requests => ({ requests, origin: '' })),
        ...connectedInstances.map(inst =>
          inst.api.social.requests().then(requests => ({ requests, origin: inst.origin }))
        ),
      ]);

      const allRequests: TaggedFriendRequest[] = [];
      const seen = new Set<string>();

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { requests, origin } = result.value;
        for (const request of requests) {
          const key = `${request.id}:${origin}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (origin && request.user) normalizeUserAssets(request.user, origin);
          allRequests.push({ ...request, _instanceOrigin: origin });
        }
      }

      set({ requests: allRequests, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  sendFriendRequest: async (username: string) => {
    set({ isLoading: true, error: null });
    try {
      const atIndex = username.lastIndexOf('@');
      let res: { success: boolean; requestId?: string };

      if (atIndex === -1) {
        // No @ → local user on home instance
        res = await api.social.sendRequest(username);
      } else {
        const baseName = username.slice(0, atIndex);
        const domain = username.slice(atIndex + 1);

        // Check if domain matches home instance
        if (domain === window.location.host) {
          // Strip domain, send to home API
          res = await api.social.sendRequest(baseName);
        } else {
          // Find a connected instance matching this domain
          const instances = useInstanceStore.getState().instances;
          const match = instances.find(inst => {
            try {
              return new URL(inst.origin).host === domain;
            } catch {
              return false;
            }
          });

          if (!match) {
            throw new InstanceNotConnectedError(domain);
          }

          if (match.status !== 'connected') {
            throw new InstanceDisconnectedError(domain);
          }

          // On the remote instance, the user is just "alice", not "alice@orbit"
          res = await match.api.social.sendRequest(baseName);
        }
      }

      await get().loadRequests();
      return res.requestId;
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  updateFriendRequest: async (id: string, status: 'accepted' | 'declined') => {
    set({ isLoading: true, error: null });
    try {
      // Find the request to determine which instance owns it
      const request = get().requests.find(r => r.id === id);
      const origin = request?._instanceOrigin ?? '';
      const client = getApiForOrigin(origin);

      await client.social.updateRequest(id, status);
      await get().loadRequests();
      if (status === 'accepted') {
        await get().loadFriends();
      }
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  cancelFriendRequest: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const request = get().requests.find(r => r.id === id);
      const origin = request?._instanceOrigin ?? '';
      const client = getApiForOrigin(origin);

      await client.social.cancelRequest(id);
      set((state) => ({
        requests: state.requests.filter(r => r.id !== id),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  removeFriend: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      // Find the friend to determine which instance owns it
      const friend = get().friends.find(f => f.id === id);
      const origin = friend?._instanceOrigin ?? '';
      const client = getApiForOrigin(origin);

      await client.social.removeFriend(id);
      set((state) => ({
        friends: state.friends.filter(f => !(f.id === id && f._instanceOrigin === origin)),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  searchUsers: async (query: string) => {
    try {
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

      const allUsers: User[] = [];
      const seen = new Set<string>();

      results.forEach((result, i) => {
        if (result.status !== 'fulfilled') return;
        const origin = searches[i]!.origin;
        for (const user of result.value) {
          const dedupeKey = `${origin ?? ''}:${user.id}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          if (origin) normalizeUserAssets(user, origin);
          allUsers.push(user);
        }
      });

      return allUsers;
    } catch (err) {
      console.error('Failed to search users:', err);
      return [];
    }
  },

  // Called from WS handler when another user sends you a friend request
  addIncomingRequest: (request: FriendRequest, origin: string) => {
    set((state) => {
      const key = `${request.id}:${origin}`;
      if (state.requests.find(r => `${r.id}:${r._instanceOrigin}` === key)) return state;
      return { requests: [...state.requests, { ...request, _instanceOrigin: origin }] };
    });
  },

  // Called from WS handler when someone accepts your friend request
  addFriendFromAccepted: (friend: Friend, requestId: string, origin: string) => {
    set((state) => {
      const key = `${friend.id}:${origin}`;
      const alreadyExists = state.friends.some(f => `${f.id}:${f._instanceOrigin}` === key);
      return {
        friends: alreadyExists ? state.friends : [...state.friends, { ...friend, _instanceOrigin: origin }],
        requests: state.requests.filter(r => !(r.id === requestId && r._instanceOrigin === origin)),
      };
    });
  },

  // Called from WS handler when the other user removes us as a friend
  removeFriendLocally: (userId: string, origin: string) => {
    set((state) => ({
      friends: state.friends.filter(f => !(f.id === userId && f._instanceOrigin === origin)),
    }));
  },

  // Called from WS handler when a friend request is cancelled or declined
  removeRequestById: (requestId: string, origin: string) => {
    set((state) => ({
      requests: state.requests.filter(r => !(r.id === requestId && r._instanceOrigin === origin)),
    }));
  },

  // Called from WS handler on presence_update to keep friend status live
  updateFriendPresence: (userId: string, status: string) => {
    set((state) => ({
      friends: state.friends.map(f =>
        f.id === userId ? { ...f, status: status as Friend['status'] } : f
      ),
    }));
  },

  // Called from WS handler on user_updated to keep friend profile data live
  updateFriendProfile: (user: User) => {
    set((state) => ({
      friends: state.friends.map(f =>
        f.id === user.id
          ? { ...f, displayName: user.displayName, avatar: user.avatar,
              banner: user.banner, accentColor: user.accentColor,
              avatarColor: user.avatarColor, bio: user.bio,
              customStatus: user.customStatus, status: user.status }
          : f
      ),
    }));
  },

  reset: () => set({ friends: [], requests: [], isLoading: false, error: null }),
}));
