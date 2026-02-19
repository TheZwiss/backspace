import { create } from 'zustand';
import { api } from '../api/client';
import { wsSend } from '../hooks/useWebSocket';
import { isDmChannel } from './serverStore';
export const useChatStore = create((set, get) => ({
    messages: new Map(),
    currentChannelId: null,
    typingUsers: new Map(),
    hasMore: new Map(),
    isLoading: false,
    loadError: null,
    replyTo: null,
    readStates: new Map(),
    unreadChannels: new Set(),
    setCurrentChannel: (channelId) => set({ currentChannelId: channelId }),
    setReplyTo: (message) => set({ replyTo: message }),
    clearAllMessages: () => set({ messages: new Map(), hasMore: new Map() }),
    loadMessages: async (channelId, force) => {
        if (!force && get().messages.has(channelId))
            return;
        set({ isLoading: true, loadError: null });
        try {
            const isDm = isDmChannel(channelId);
            const messages = isDm
                ? await api.dm.messages(channelId)
                : await api.channels.messages(channelId);
            set((state) => {
                const newMessages = new Map(state.messages);
                newMessages.set(channelId, messages);
                const newHasMore = new Map(state.hasMore);
                newHasMore.set(channelId, messages.length >= 50);
                return { messages: newMessages, hasMore: newHasMore, isLoading: false, loadError: null };
            });
        }
        catch (err) {
            set({ isLoading: false, loadError: err.message || 'Failed to load messages' });
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
            const isDm = isDmChannel(channelId);
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
        const isDm = isDmChannel(channelId);
        if (isDm) {
            await api.dm.sendMessage(channelId, { content });
        }
        else {
            await api.channels.sendMessage(channelId, { content, attachments: attachmentIds, replyToId });
        }
        set({ replyTo: null });
        // Message will arrive via WebSocket
    },
    editMessage: async (messageId, content, channelId) => {
        const isDm = isDmChannel(channelId);
        if (isDm) {
            await api.dm.updateMessage(messageId, { content });
        }
        else {
            await api.messages.update(messageId, { content });
        }
        // Update will arrive via WebSocket
    },
    deleteMessage: async (messageId, channelId) => {
        const isDm = isDmChannel(channelId);
        if (isDm) {
            await api.dm.deleteMessage(messageId);
        }
        else {
            await api.messages.delete(messageId);
        }
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
        // DM messages have dmChannelId instead of channelId — check both
        const channelKey = message.channelId || message.dmChannelId;
        if (!channelKey)
            return;
        set((state) => {
            const newMessages = new Map(state.messages);
            const current = newMessages.get(channelKey);
            if (!current)
                return state;
            newMessages.set(channelKey, current.map(m => m.id === message.id ? message : m));
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
    setReadStates: (readStates, channelLastMessageIds) => {
        const rsMap = new Map();
        for (const rs of readStates) {
            rsMap.set(rs.channelId, rs.lastReadMessageId);
        }
        const unread = new Set();
        for (const [channelId, lastMsgId] of channelLastMessageIds) {
            const lastRead = rsMap.get(channelId);
            if (!lastRead || BigInt(lastMsgId) > BigInt(lastRead)) {
                unread.add(channelId);
            }
        }
        set({ readStates: rsMap, unreadChannels: unread });
    },
    markChannelUnread: (channelId) => {
        set((state) => {
            if (state.unreadChannels.has(channelId))
                return state;
            const newUnread = new Set(state.unreadChannels);
            newUnread.add(channelId);
            return { unreadChannels: newUnread };
        });
    },
    ackChannel: (channelId) => {
        const msgs = get().messages.get(channelId);
        if (!msgs || msgs.length === 0)
            return;
        const lastMsg = msgs[msgs.length - 1];
        if (!lastMsg)
            return;
        const messageId = lastMsg.id;
        // Update local state immediately
        set((state) => {
            const newReadStates = new Map(state.readStates);
            newReadStates.set(channelId, messageId);
            const newUnread = new Set(state.unreadChannels);
            newUnread.delete(channelId);
            return { readStates: newReadStates, unreadChannels: newUnread };
        });
        // Send to server
        wsSend({ type: 'channel_ack', channelId, messageId });
    },
    onChannelAck: (channelId, messageId) => {
        set((state) => {
            const newReadStates = new Map(state.readStates);
            newReadStates.set(channelId, messageId);
            const newUnread = new Set(state.unreadChannels);
            newUnread.delete(channelId);
            return { readStates: newReadStates, unreadChannels: newUnread };
        });
    },
}));
