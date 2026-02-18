import { create } from 'zustand';
import { api } from '../api/client';
export const useChatStore = create((set, get) => ({
    messages: new Map(),
    currentChannelId: null,
    typingUsers: new Map(),
    hasMore: new Map(),
    isLoading: false,
    setCurrentChannel: (channelId) => set({ currentChannelId: channelId }),
    loadMessages: async (channelId) => {
        if (get().messages.has(channelId))
            return;
        set({ isLoading: true });
        try {
            const messages = await api.channels.messages(channelId);
            set((state) => {
                const newMessages = new Map(state.messages);
                newMessages.set(channelId, messages);
                const newHasMore = new Map(state.hasMore);
                newHasMore.set(channelId, messages.length >= 50);
                return { messages: newMessages, hasMore: newHasMore, isLoading: false };
            });
        }
        catch {
            set({ isLoading: false });
        }
    },
    loadMoreMessages: async (channelId) => {
        const existing = get().messages.get(channelId);
        if (!existing || existing.length === 0)
            return false;
        if (!get().hasMore.get(channelId))
            return false;
        const oldestMessage = existing[0];
        if (!oldestMessage)
            return false;
        try {
            const olderMessages = await api.channels.messages(channelId, oldestMessage.id);
            set((state) => {
                const newMessages = new Map(state.messages);
                const current = newMessages.get(channelId) ?? [];
                newMessages.set(channelId, [...olderMessages, ...current]);
                const newHasMore = new Map(state.hasMore);
                newHasMore.set(channelId, olderMessages.length >= 50);
                return { messages: newMessages, hasMore: newHasMore };
            });
            return olderMessages.length > 0;
        }
        catch {
            return false;
        }
    },
    sendMessage: async (channelId, content, attachmentIds) => {
        await api.channels.sendMessage(channelId, { content, attachments: attachmentIds });
        // Message will arrive via WebSocket
    },
    editMessage: async (messageId, content) => {
        await api.messages.update(messageId, { content });
        // Update will arrive via WebSocket
    },
    deleteMessage: async (messageId) => {
        await api.messages.delete(messageId);
        // Deletion will arrive via WebSocket
    },
    addMessage: (channelId, message) => {
        set((state) => {
            const newMessages = new Map(state.messages);
            const current = newMessages.get(channelId) ?? [];
            // Avoid duplicates
            if (current.find(m => m.id === message.id))
                return state;
            newMessages.set(channelId, [...current, message]);
            return { messages: newMessages };
        });
    },
    updateMessage: (message) => {
        set((state) => {
            const newMessages = new Map(state.messages);
            const current = newMessages.get(message.channelId);
            if (!current)
                return state;
            newMessages.set(message.channelId, current.map(m => m.id === message.id ? message : m));
            return { messages: newMessages };
        });
    },
    removeMessage: (messageId, channelId) => {
        set((state) => {
            const newMessages = new Map(state.messages);
            const current = newMessages.get(channelId);
            if (!current)
                return state;
            newMessages.set(channelId, current.filter(m => m.id !== messageId));
            return { messages: newMessages };
        });
    },
    setTyping: (channelId, userId, username) => {
        set((state) => {
            const newTyping = new Map(state.typingUsers);
            const current = newTyping.get(channelId) ?? [];
            const filtered = current.filter(t => t.userId !== userId);
            filtered.push({ userId, username, timestamp: Date.now() });
            newTyping.set(channelId, filtered);
            return { typingUsers: newTyping };
        });
        // Auto-clear after 5 seconds
        setTimeout(() => {
            get().clearTyping(channelId, userId);
        }, 5000);
    },
    clearTyping: (channelId, userId) => {
        set((state) => {
            const newTyping = new Map(state.typingUsers);
            const current = newTyping.get(channelId);
            if (!current)
                return state;
            newTyping.set(channelId, current.filter(t => t.userId !== userId));
            return { typingUsers: newTyping };
        });
    },
    getMessages: (channelId) => {
        return get().messages.get(channelId) ?? [];
    },
    getTypingUsers: (channelId) => {
        const users = get().typingUsers.get(channelId) ?? [];
        const now = Date.now();
        return users.filter(t => now - t.timestamp < 5000);
    },
}));
