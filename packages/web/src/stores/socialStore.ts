import { create } from 'zustand';
import type { Friend, FriendRequest, User } from '@backspace/shared';
import { api } from '../api/client';

interface SocialState {
  friends: Friend[];
  requests: FriendRequest[];
  isLoading: boolean;
  error: string | null;
  loadFriends: () => Promise<void>;
  loadRequests: () => Promise<void>;
  sendFriendRequest: (username: string) => Promise<void>;
  updateFriendRequest: (id: string, status: 'accepted' | 'declined') => Promise<void>;
  cancelFriendRequest: (id: string) => Promise<void>;
  removeFriend: (id: string) => Promise<void>;
  searchUsers: (query: string) => Promise<User[]>;
  addIncomingRequest: (request: FriendRequest) => void;
  addFriendFromAccepted: (friend: Friend, requestId: string) => void;
  updateFriendPresence: (userId: string, status: string) => void;
  removeFriendLocally: (userId: string) => void;
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
      const friends = await api.social.friends();
      set({ friends, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  loadRequests: async () => {
    set({ isLoading: true, error: null });
    try {
      const requests = await api.social.requests();
      set({ requests, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  sendFriendRequest: async (username: string) => {
    set({ isLoading: true, error: null });
    try {
      await api.social.sendRequest(username);
      await get().loadRequests();
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  updateFriendRequest: async (id: string, status: 'accepted' | 'declined') => {
    set({ isLoading: true, error: null });
    try {
      await api.social.updateRequest(id, status);
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
      await api.social.cancelRequest(id);
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
      await api.social.removeFriend(id);
      set((state) => ({
        friends: state.friends.filter((f) => f.id !== id),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  searchUsers: async (query: string) => {
    try {
      return await api.social.search(query);
    } catch (err) {
      console.error('Failed to search users:', err);
      return [];
    }
  },

  // Called from WS handler when another user sends you a friend request
  addIncomingRequest: (request: FriendRequest) => {
    set((state) => {
      if (state.requests.find(r => r.id === request.id)) return state;
      return { requests: [...state.requests, request] };
    });
  },

  // Called from WS handler when someone accepts your friend request
  addFriendFromAccepted: (friend: Friend, requestId: string) => {
    set((state) => ({
      friends: state.friends.find(f => f.id === friend.id) ? state.friends : [...state.friends, friend],
      requests: state.requests.filter(r => r.id !== requestId),
    }));
  },

  // Called from WS handler when the other user removes us as a friend
  removeFriendLocally: (userId: string) => {
    set((state) => ({
      friends: state.friends.filter(f => f.id !== userId),
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

  reset: () => set({ friends: [], requests: [], isLoading: false, error: null }),
}));
