import { create } from 'zustand';
import { api } from '../api/client';
export const useSocialStore = create((set, get) => ({
    friends: [],
    requests: [],
    isLoading: false,
    error: null,
    loadFriends: async () => {
        set({ isLoading: true, error: null });
        try {
            const friends = await api.social.friends();
            set({ friends, isLoading: false });
        }
        catch (err) {
            set({ error: err.message, isLoading: false });
        }
    },
    loadRequests: async () => {
        set({ isLoading: true, error: null });
        try {
            const requests = await api.social.requests();
            set({ requests, isLoading: false });
        }
        catch (err) {
            set({ error: err.message, isLoading: false });
        }
    },
    sendFriendRequest: async (username) => {
        set({ isLoading: true, error: null });
        try {
            await api.social.sendRequest(username);
            await get().loadRequests();
        }
        catch (err) {
            set({ error: err.message, isLoading: false });
            throw err;
        }
    },
    updateFriendRequest: async (id, status) => {
        set({ isLoading: true, error: null });
        try {
            await api.social.updateRequest(id, status);
            await get().loadRequests();
            if (status === 'accepted') {
                await get().loadFriends();
            }
        }
        catch (err) {
            set({ error: err.message, isLoading: false });
            throw err;
        }
    },
    removeFriend: async (id) => {
        set({ isLoading: true, error: null });
        try {
            await api.social.removeFriend(id);
            set((state) => ({
                friends: state.friends.filter((f) => f.id !== id),
                isLoading: false,
            }));
        }
        catch (err) {
            set({ error: err.message, isLoading: false });
            throw err;
        }
    },
    searchUsers: async (query) => {
        try {
            return await api.social.search(query);
        }
        catch (err) {
            console.error('Failed to search users:', err);
            return [];
        }
    },
}));
