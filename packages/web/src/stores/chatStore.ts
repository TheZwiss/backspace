import { create } from 'zustand';
import type { MessageWithUser } from '@opencord/shared';
import { api } from '../api/client';

interface TypingUser {
  userId: string;
  username: string;
  timestamp: number;
}

interface ChatState {
  messages: Map<string, MessageWithUser[]>;
  currentChannelId: string | null;
  typingUsers: Map<string, TypingUser[]>;
  hasMore: Map<string, boolean>;
  isLoading: boolean;
  setCurrentChannel: (channelId: string | null) => void;
  loadMessages: (channelId: string) => Promise<void>;
  loadMoreMessages: (channelId: string) => Promise<boolean>;
  sendMessage: (channelId: string, content: string, attachmentIds?: string[]) => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  addMessage: (channelId: string, message: MessageWithUser) => void;
  updateMessage: (message: MessageWithUser) => void;
  removeMessage: (messageId: string, channelId: string) => void;
  setTyping: (channelId: string, userId: string, username: string) => void;
  clearTyping: (channelId: string, userId: string) => void;
  getMessages: (channelId: string) => MessageWithUser[];
  getTypingUsers: (channelId: string) => TypingUser[];
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: new Map(),
  currentChannelId: null,
  typingUsers: new Map(),
  hasMore: new Map(),
  isLoading: false,

  setCurrentChannel: (channelId) => set({ currentChannelId: channelId }),

  loadMessages: async (channelId: string) => {
    if (get().messages.has(channelId)) return;
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
    } catch {
      set({ isLoading: false });
    }
  },

  loadMoreMessages: async (channelId: string) => {
    const existing = get().messages.get(channelId);
    if (!existing || existing.length === 0) return false;
    if (!get().hasMore.get(channelId)) return false;

    const oldestMessage = existing[0];
    if (!oldestMessage) return false;

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
    } catch {
      return false;
    }
  },

  sendMessage: async (channelId: string, content: string, attachmentIds?: string[]) => {
    await api.channels.sendMessage(channelId, { content, attachments: attachmentIds });
    // Message will arrive via WebSocket
  },

  editMessage: async (messageId: string, content: string) => {
    await api.messages.update(messageId, { content });
    // Update will arrive via WebSocket
  },

  deleteMessage: async (messageId: string) => {
    await api.messages.delete(messageId);
    // Deletion will arrive via WebSocket
  },

  addMessage: (channelId: string, message: MessageWithUser) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      const current = newMessages.get(channelId) ?? [];
      // Avoid duplicates
      if (current.find(m => m.id === message.id)) return state;
      newMessages.set(channelId, [...current, message]);
      return { messages: newMessages };
    });
  },

  updateMessage: (message: MessageWithUser) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      const current = newMessages.get(message.channelId);
      if (!current) return state;
      newMessages.set(
        message.channelId,
        current.map(m => m.id === message.id ? message : m),
      );
      return { messages: newMessages };
    });
  },

  removeMessage: (messageId: string, channelId: string) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      const current = newMessages.get(channelId);
      if (!current) return state;
      newMessages.set(channelId, current.filter(m => m.id !== messageId));
      return { messages: newMessages };
    });
  },

  setTyping: (channelId: string, userId: string, username: string) => {
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

  clearTyping: (channelId: string, userId: string) => {
    set((state) => {
      const newTyping = new Map(state.typingUsers);
      const current = newTyping.get(channelId);
      if (!current) return state;
      newTyping.set(channelId, current.filter(t => t.userId !== userId));
      return { typingUsers: newTyping };
    });
  },

  getMessages: (channelId: string) => {
    return get().messages.get(channelId) ?? [];
  },

  getTypingUsers: (channelId: string) => {
    const users = get().typingUsers.get(channelId) ?? [];
    const now = Date.now();
    return users.filter(t => now - t.timestamp < 5000);
  },
}));
