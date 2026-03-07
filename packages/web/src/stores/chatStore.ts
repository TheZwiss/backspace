import { create } from 'zustand';
import type { MessageWithUser, Reaction, ReadState } from '@backspace/shared';
import { wsSend } from '../hooks/useWebSocket';
import { isDmChannel, getChannelOrigin, getApiForOrigin, useServerStore } from './serverStore';
import { useAuthStore } from './authStore';
import { normalizeMessageAssets } from '../utils/assetUrls';

const MAX_MESSAGES_PER_CHANNEL = 200;
const MAX_CACHED_CHANNELS = 20;
const EVICT_TO_CHANNELS = 15;

interface TypingUser {
  userId: string;
  username: string;
  timestamp: number;
}

interface RealtimeMessageEvent {
  channelId: string;
  message: MessageWithUser;
}

interface ChatState {
  messages: Map<string, MessageWithUser[]>;
  currentChannelId: string | null;
  typingUsers: Map<string, TypingUser[]>;
  hasMore: Map<string, boolean>;
  isLoading: boolean;
  loadError: string | null;
  replyTo: MessageWithUser | null;
  readStates: Map<string, string>;
  unreadChannels: Set<string>;
  realtimeMessageEvents: RealtimeMessageEvent[];
  channelAccessTimes: Map<string, number>;
  setCurrentChannel: (channelId: string | null) => void;
  setReplyTo: (message: MessageWithUser | null) => void;
  loadMessages: (channelId: string, force?: boolean) => Promise<void>;
  clearAllMessages: () => void;
  loadMoreMessages: (channelId: string) => Promise<boolean>;
  sendMessage: (channelId: string, content: string, attachmentIds?: string[]) => Promise<void>;
  editMessage: (messageId: string, content: string, channelId: string) => Promise<void>;
  deleteMessage: (messageId: string, channelId: string) => Promise<void>;
  addMessage: (channelId: string, message: MessageWithUser) => void;
  addRealtimeMessage: (channelId: string, message: MessageWithUser) => void;
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
  setReadStates: (readStates: ReadState[], channelLastMessageIds: Map<string, string>) => void;
  markChannelUnread: (channelId: string) => void;
  ackChannel: (channelId: string) => void;
  onChannelAck: (channelId: string, messageId: string) => void;
}

/** Find which channel a message belongs to by scanning the message cache. */
function findChannelForMessage(messages: Map<string, MessageWithUser[]>, messageId: string): string | null {
  for (const [channelId, msgs] of messages) {
    if (msgs.some(m => m.id === messageId)) {
      return channelId;
    }
  }
  return null;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: new Map(),
  currentChannelId: null,
  typingUsers: new Map(),
  hasMore: new Map(),
  isLoading: false,
  loadError: null,
  replyTo: null,
  readStates: new Map(),
  unreadChannels: new Set(),
  realtimeMessageEvents: [],
  channelAccessTimes: new Map(),

  setCurrentChannel: (channelId) => {
    set((state) => {
      const newAccessTimes = new Map(state.channelAccessTimes);
      if (channelId) {
        newAccessTimes.set(channelId, Date.now());
      }

      // Evict stale channels if we have too many cached
      let newMessages = state.messages;
      let newHasMore = state.hasMore;
      if (state.messages.size > MAX_CACHED_CHANNELS) {
        const entries = [...newAccessTimes.entries()]
          .filter(([id]) => id !== channelId)
          .sort((a, b) => a[1] - b[1]);
        const toEvict = state.messages.size - EVICT_TO_CHANNELS;
        const evictIds = new Set(entries.slice(0, toEvict).map(([id]) => id));
        if (evictIds.size > 0) {
          newMessages = new Map(state.messages);
          newHasMore = new Map(state.hasMore);
          for (const id of evictIds) {
            newMessages.delete(id);
            newHasMore.delete(id);
            newAccessTimes.delete(id);
          }
        }
      }

      return {
        currentChannelId: channelId,
        channelAccessTimes: newAccessTimes,
        messages: newMessages,
        hasMore: newHasMore,
      };
    });
  },
  setReplyTo: (message) => set({ replyTo: message }),

  clearAllMessages: () => set({
    messages: new Map(),
    hasMore: new Map(),
    typingUsers: new Map(),
    readStates: new Map(),
    unreadChannels: new Set(),
    realtimeMessageEvents: [],
    channelAccessTimes: new Map(),
    currentChannelId: null,
    replyTo: null,
  }),

  loadMessages: async (channelId: string, force?: boolean) => {
    if (!force && get().hasMore.has(channelId)) return;
    const isDm = isDmChannel(channelId);
    // For server channels, bail if we don't know which instance owns this channel yet.
    // The remote WS ready handler will call loadMessages once the map is populated.
    if (!isDm && !useServerStore.getState().channelOriginMap.has(channelId)) return;
    set({ isLoading: true, loadError: null });
    try {
      const origin = getChannelOrigin(channelId);
      const client = getApiForOrigin(origin);
      const messages = isDm
        ? await client.dm.messages(channelId)
        : await client.channels.messages(channelId);

      // Normalize remote asset URLs (avatars, attachment filenames)
      if (origin) {
        for (const msg of messages) normalizeMessageAssets(msg, origin);
      }

      set((state) => {
        const newMessages = new Map(state.messages);
        newMessages.set(channelId, messages as MessageWithUser[]);
        const newHasMore = new Map(state.hasMore);
        newHasMore.set(channelId, messages.length >= 50);
        const newAccessTimes = new Map(state.channelAccessTimes);
        newAccessTimes.set(channelId, Date.now());
        return { messages: newMessages, hasMore: newHasMore, channelAccessTimes: newAccessTimes, isLoading: false, loadError: null };
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
      const isDm = isDmChannel(channelId);
      const origin = getChannelOrigin(channelId);
      const client = getApiForOrigin(origin);
      const olderMessages = isDm
        ? await client.dm.messages(channelId, oldestMessage.id)
        : await client.channels.messages(channelId, oldestMessage.id);

      // Normalize remote asset URLs (avatars, attachment filenames)
      if (origin) {
        for (const msg of olderMessages) normalizeMessageAssets(msg, origin);
      }

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
    const isDm = isDmChannel(channelId);
    const currentUser = useAuthStore.getState().user;
    const origin = getChannelOrigin(channelId);
    const client = getApiForOrigin(origin);

    // Generate optimistic message
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (currentUser) {
      const optimisticMessage: MessageWithUser = {
        id: tempId,
        channelId: isDm ? '' : channelId,
        userId: currentUser.id,
        content,
        replyToId: replyToId ?? null,
        editedAt: null,
        createdAt: Date.now(),
        user: currentUser,
        attachments: [],
        reactions: [],
        replyTo: get().replyTo ?? undefined,
      };
      if (isDm) {
        (optimisticMessage as any).dmChannelId = channelId;
      }
      // Add optimistic message immediately
      get().addMessage(channelId, optimisticMessage);

      // For DMs, update lastMessage on the DM channel so sidebar re-sorts
      if (isDm) {
        const { dmChannels, setDmChannels } = useServerStore.getState();
        const updatedDms = dmChannels.map(dm =>
          dm.id === channelId
            ? { ...dm, lastMessage: { id: tempId, dmChannelId: channelId, userId: currentUser.id, content, createdAt: Date.now() } }
            : dm
        );
        updatedDms.sort((a, b) => {
          const aTime = a.lastMessage?.createdAt ?? a.createdAt;
          const bTime = b.lastMessage?.createdAt ?? b.createdAt;
          return bTime - aTime;
        });
        setDmChannels(updatedDms);
      }
    }

    set({ replyTo: null });

    try {
      if (isDm) {
        await client.dm.sendMessage(channelId, { content, attachments: attachmentIds, replyToId });
      } else {
        await client.channels.sendMessage(channelId, { content, attachments: attachmentIds, replyToId });
      }
      // Real message will arrive via WebSocket and replace the temp one
    } catch {
      // Rollback: remove the optimistic message on failure
      get().removeMessage(tempId, channelId);
    }
  },

  editMessage: async (messageId: string, content: string, channelId: string) => {
    const isDm = isDmChannel(channelId);
    const origin = getChannelOrigin(channelId);
    const client = getApiForOrigin(origin);

    // Optimistic: update content locally first
    const messages = get().messages.get(channelId);
    const originalMessage = messages?.find(m => m.id === messageId);
    if (originalMessage) {
      get().updateMessage({ ...originalMessage, content, editedAt: Date.now() });
    }
    try {
      if (isDm) {
        await client.dm.updateMessage(messageId, { content });
      } else {
        await client.messages.update(messageId, { content });
      }
      // Real update will arrive via WebSocket
    } catch {
      // Rollback: restore the original message on failure
      if (originalMessage) {
        get().updateMessage(originalMessage);
      }
    }
  },

  deleteMessage: async (messageId: string, channelId: string) => {
    const isDm = isDmChannel(channelId);
    const origin = getChannelOrigin(channelId);
    const client = getApiForOrigin(origin);

    // Optimistic: remove locally first
    const messages = get().messages.get(channelId);
    const savedMessage = messages?.find(m => m.id === messageId);
    get().removeMessage(messageId, channelId);
    try {
      if (isDm) {
        await client.dm.deleteMessage(messageId);
      } else {
        await client.messages.delete(messageId);
      }
      // Real deletion will arrive via WebSocket (already removed locally)
    } catch {
      // Rollback: re-add the message on failure
      if (savedMessage) {
        get().addMessage(channelId, savedMessage);
      }
    }
  },

  addMessage: (channelId: string, message: MessageWithUser) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      const current = newMessages.get(channelId) ?? [];
      // Avoid duplicates
      if (current.find(m => m.id === message.id)) return state;
      // Remove any optimistic temp message with same content.
      // Don't require userId match — for federated messages the home user ID
      // differs from the replicated user ID, but content match is sufficient
      // since temp messages are unique within the short optimistic window.
      const filtered = current.filter(m => {
        if (!m.id.startsWith('temp_')) return true;
        return m.content !== message.content;
      });
      let updated = [...filtered, message];
      // Cap per-channel messages to prevent memory growth
      if (updated.length > MAX_MESSAGES_PER_CHANNEL) {
        updated = updated.slice(updated.length - MAX_MESSAGES_PER_CHANNEL);
      }
      newMessages.set(channelId, updated);
      return { messages: newMessages };
    });
  },

  addRealtimeMessage: (channelId: string, message: MessageWithUser) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      const current = newMessages.get(channelId) ?? [];
      // Avoid duplicates
      if (current.find(m => m.id === message.id)) return state;
      // Remove any optimistic temp message with same content (no userId check —
      // federated messages arrive with a different replicated user ID)
      const filtered = current.filter(m => {
        if (!m.id.startsWith('temp_')) return true;
        return m.content !== message.content;
      });
      let updated = [...filtered, message];
      // Cap per-channel messages to prevent memory growth
      if (updated.length > MAX_MESSAGES_PER_CHANNEL) {
        updated = updated.slice(updated.length - MAX_MESSAGES_PER_CHANNEL);
      }
      newMessages.set(channelId, updated);
      // Append to realtimeMessageEvents (capped at 50)
      const newEvents = [...state.realtimeMessageEvents, { channelId, message }];
      if (newEvents.length > 50) newEvents.splice(0, newEvents.length - 50);
      return { messages: newMessages, realtimeMessageEvents: newEvents };
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
    // Resolve the channel from our message cache so the UI doesn't need to pass it
    const channelId = findChannelForMessage(get().messages, messageId);
    const origin = channelId ? getChannelOrigin(channelId) : '';
    wsSend({ type: 'reaction_add', messageId, emoji }, origin);
  },

  removeReaction: (messageId: string, emoji: string) => {
    const channelId = findChannelForMessage(get().messages, messageId);
    const origin = channelId ? getChannelOrigin(channelId) : '';
    wsSend({ type: 'reaction_remove', messageId, emoji }, origin);
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

  setReadStates: (readStates: ReadState[], channelLastMessageIds: Map<string, string>) => {
    const rsMap = new Map<string, string>();
    for (const rs of readStates) {
      rsMap.set(rs.channelId, rs.lastReadMessageId);
    }
    const unread = new Set<string>();
    for (const [channelId, lastMsgId] of channelLastMessageIds) {
      const lastRead = rsMap.get(channelId);
      if (!lastRead) {
        unread.add(channelId);
        continue;
      }
      try {
        if (BigInt(lastMsgId) > BigInt(lastRead)) {
          unread.add(channelId);
        }
      } catch {
        // Corrupted read state (e.g. temp_ ID) — treat as unread
        unread.add(channelId);
      }
    }
    set({ readStates: rsMap, unreadChannels: unread });
  },

  markChannelUnread: (channelId: string) => {
    set((state) => {
      if (state.unreadChannels.has(channelId)) return state;
      const newUnread = new Set(state.unreadChannels);
      newUnread.add(channelId);
      return { unreadChannels: newUnread };
    });
  },

  ackChannel: (channelId: string) => {
    const msgs = get().messages.get(channelId);
    if (!msgs || msgs.length === 0) return;
    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg) return;
    const messageId = lastMsg.id;
    // Don't ack optimistic/temp messages — wait for the real server ID
    if (messageId.startsWith('temp_')) return;

    // Update local state immediately
    set((state) => {
      const newReadStates = new Map(state.readStates);
      newReadStates.set(channelId, messageId);
      const newUnread = new Set(state.unreadChannels);
      newUnread.delete(channelId);
      return { readStates: newReadStates, unreadChannels: newUnread };
    });

    // Send to the correct instance
    const origin = getChannelOrigin(channelId);
    wsSend({ type: 'channel_ack', channelId, messageId }, origin);
  },

  onChannelAck: (channelId: string, messageId: string) => {
    set((state) => {
      const newReadStates = new Map(state.readStates);
      newReadStates.set(channelId, messageId);
      const newUnread = new Set(state.unreadChannels);
      newUnread.delete(channelId);
      return { readStates: newReadStates, unreadChannels: newUnread };
    });
  },
}));
