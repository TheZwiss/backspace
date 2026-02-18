import { create } from 'zustand';
import { api } from '../api/client';
import { wsSend } from '../hooks/useWebSocket';
import { useUIStore } from './uiStore';
export const useChatStore = create((set, get) => ({
    messages: new Map(),
    currentChannelId: null,
    typingUsers: new Map(),
    hasMore: new Map(),
    isLoading: false,
    replyTo: null,
    setCurrentChannel: (channelId) => set({ currentChannelId: channelId }),
    setReplyTo: (message) => set({ replyTo: message }),
    loadMessages: async (channelId) => {
        if (get().messages.has(channelId))
            return;
        set({ isLoading: true });
        try {
            const isDm = useUIStore.getState().showDms;
            const messages = isDm
                ? await api.dm.messages(channelId)
                : await api.channels.messages(channelId);
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
            const isDm = useUIStore.getState().showDms;
            const olderMessages = isDm
                ? await api.dm.messages(channelId, oldestMessage.id)
                : await api.channels.messages(channelId, oldestMessage.id);
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
        const replyToId = get().replyTo?.id;
        const isDm = useUIStore.getState().showDms;
        if (isDm) {
            await api.dm.sendMessage(channelId, { content });
        }
        else {
            await api.channels.sendMessage(channelId, { content, attachments: attachmentIds, replyToId });
        }
        set({ replyTo: null });
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
    addReaction: (messageId, emoji) => {
        wsSend({ type: 'reaction_add', messageId, emoji });
    },
    removeReaction: (messageId, emoji) => {
        wsSend({ type: 'reaction_remove', messageId, emoji });
    },
    onReactionAdded: (messageId, reaction) => {
        set((state) => {
            const newMessages = new Map(state.messages);
            for (const [channelId, msgs] of newMessages.entries()) {
                const msgIndex = msgs.findIndex(m => m.id === messageId);
                if (msgIndex !== -1) {
                    const newMsgs = [...msgs];
                    const oldMsg = newMsgs[msgIndex];
                    newMsgs[msgIndex] = {
                        ...oldMsg,
                        reactions: [...(oldMsg.reactions || []), reaction],
                    };
                    newMessages.set(channelId, newMsgs);
                    break;
                }
            }
            return { messages: newMessages };
        });
    },
    onReactionRemoved: (messageId, userId, emoji) => {
        set((state) => {
            const newMessages = new Map(state.messages);
            for (const [channelId, msgs] of newMessages.entries()) {
                const msgIndex = msgs.findIndex(m => m.id === messageId);
                if (msgIndex !== -1) {
                    const newMsgs = [...msgs];
                    const oldMsg = newMsgs[msgIndex];
                    newMsgs[msgIndex] = {
                        ...oldMsg,
                        reactions: (oldMsg.reactions || []).filter(r => !(r.userId === userId && r.emoji === emoji)),
                    };
                    newMessages.set(channelId, newMsgs);
                    break;
                }
            }
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
