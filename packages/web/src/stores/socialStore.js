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
    cancelFriendRequest: async (id) => {
        set({ isLoading: true, error: null });
        try {
            await api.social.cancelRequest(id);
            set((state) => ({
                requests: state.requests.filter(r => r.id !== id),
                isLoading: false,
            }));
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
    // Called from WS handler when another user sends you a friend request
    addIncomingRequest: (request) => {
        set((state) => {
            if (state.requests.find(r => r.id === request.id))
                return state;
            return { requests: [...state.requests, request] };
        });
    },
    // Called from WS handler when someone accepts your friend request
    addFriendFromAccepted: (friend, requestId) => {
        set((state) => ({
            friends: state.friends.find(f => f.id === friend.id) ? state.friends : [...state.friends, friend],
            requests: state.requests.filter(r => r.id !== requestId),
        }));
    },
}));
