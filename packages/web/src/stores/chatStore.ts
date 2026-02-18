import { create } from 'zustand';
import type { MessageWithUser, Reaction } from '@opencord/shared';
import { api } from '../api/client';
import { wsSend } from '../hooks/useWebSocket';
import { useUIStore } from './uiStore';

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
  loadError: string | null;
  replyTo: MessageWithUser | null;
  setCurrentChannel: (channelId: string | null) => void;
  setReplyTo: (message: MessageWithUser | null) => void;
  loadMessages: (channelId: string) => Promise<void>;
  loadMoreMessages: (channelId: string) => Promise<boolean>;
  sendMessage: (channelId: string, content: string, attachmentIds?: string[]) => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  addMessage: (channelId: string, message: MessageWithUser) => void;
  updateMessage: (message: MessageWithUser) => void;
  removeMessage: (messageId: string, channelId: string) => void;
  addReaction: (messageId: string, emoji: string) => void;
  removeReaction: (messageId: string, emoji: string) => void;
  onReactionAdded: (messageId: string, reaction: any) => void;
  onReactionRemoved: (messageId: string, userId: string, emoji: string) => void;
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
  loadError: null,
  replyTo: null,

  setCurrentChannel: (channelId) => set({ currentChannelId: channelId }),
  setReplyTo: (message) => set({ replyTo: message }),

  loadMessages: async (channelId: string) => {
    if (get().messages.has(channelId)) return;
    set({ isLoading: true, loadError: null });
    try {
      const isDm = useUIStore.getState().showDms;
      const messages = isDm
        ? await api.dm.messages(channelId)
        : await api.channels.messages(channelId);

      set((state) => {
        const newMessages = new Map(state.messages);
        newMessages.set(channelId, messages as MessageWithUser[]);
        const newHasMore = new Map(state.hasMore);
        newHasMore.set(channelId, messages.length >= 50);
        return { messages: newMessages, hasMore: newHasMore, isLoading: false, loadError: null };
      });
    } catch (err) {
      set({ isLoading: false, loadError: (err as Error).message || 'Failed to load messages' });
    }
  },

  loadMoreMessages: async (channelId: string) => {
    const existing = get().messages.get(channelId);
    if (!existing || existing.length === 0) return false;
    if (!get().hasMore.get(channelId)) return false;

    const oldestMessage = existing[0];
    if (!oldestMessage) return false;

    try {
      const isDm = useUIStore.getState().showDms;
      const olderMessages = isDm
        ? await api.dm.messages(channelId, oldestMessage.id)
        : await api.channels.messages(channelId, oldestMessage.id);

      set((state) => {
        const newMessages = new Map(state.messages);
        const current = newMessages.get(channelId) ?? [];
        newMessages.set(channelId, [...(olderMessages as MessageWithUser[]), ...current]);
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
    const replyToId = get().replyTo?.id;
    const isDm = useUIStore.getState().showDms;
    
    if (isDm) {
      await api.dm.sendMessage(channelId, { content });
    } else {
      await api.channels.sendMessage(channelId, { content, attachments: attachmentIds, replyToId });
    }
    
    set({ replyTo: null });
    // Message will arrive via WebSocket
  },

  editMessage: async (messageId: string, content: string) => {
    const isDm = useUIStore.getState().showDms;
    if (isDm) {
      await api.dm.updateMessage(messageId, { content });
    } else {
      await api.messages.update(messageId, { content });
    }
    // Update will arrive via WebSocket
  },

  deleteMessage: async (messageId: string) => {
    const isDm = useUIStore.getState().showDms;
    if (isDm) {
      await api.dm.deleteMessage(messageId);
    } else {
      await api.messages.delete(messageId);
    }
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
    // DM messages have dmChannelId instead of channelId — check both
    const channelKey = message.channelId || (message as any).dmChannelId;
    if (!channelKey) return;
    set((state) => {
      const newMessages = new Map(state.messages);
      const current = newMessages.get(channelKey);
      if (!current) return state;
      newMessages.set(
        channelKey,
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

  addReaction: (messageId: string, emoji: string) => {
    wsSend({ type: 'reaction_add', messageId, emoji });
  },

  removeReaction: (messageId: string, emoji: string) => {
    wsSend({ type: 'reaction_remove', messageId, emoji });
  },

  onReactionAdded: (messageId: string, reaction: Reaction) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      for (const [channelId, msgs] of newMessages.entries()) {
        const msgIndex = msgs.findIndex(m => m.id === messageId);
        if (msgIndex !== -1) {
          const newMsgs = [...msgs];
          const oldMsg = newMsgs[msgIndex]!;
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

  onReactionRemoved: (messageId: string, userId: string, emoji: string) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      for (const [channelId, msgs] of newMessages.entries()) {
        const msgIndex = msgs.findIndex(m => m.id === messageId);
        if (msgIndex !== -1) {
          const newMsgs = [...msgs];
          const oldMsg = newMsgs[msgIndex]!;
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
