import { create } from 'zustand';
import type { MessageWithUser, Reaction, ReadState } from '@backspace/shared';
import { wsSend } from '../hooks/useWebSocket';
import { isDmChannel, getChannelOrigin, getApiForOrigin, useSpaceStore } from './spaceStore';
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
  scrollPositions: Map<string, string>;
  setCurrentChannel: (channelId: string | null) => void;
  saveScrollPosition: (channelId: string, messageId: string) => void;
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
  loadMessagesAround: (channelId: string, messageId: string) => Promise<void>;
  setTyping: (channelId: string, userId: string, username: string) => void;
  clearTyping: (channelId: string, userId: string) => void;
  getMessages: (channelId: string) => MessageWithUser[];
  getTypingUsers: (channelId: string) => TypingUser[];
  setReadStates: (readStates: ReadState[], channelLastMessageIds: Map<string, string>, originChannelIds?: Set<string>) => void;
  markChannelUnread: (channelId: string) => void;
  markUnread: (channelId: string, messageId: string) => void;
  ackChannel: (channelId: string) => void;
  onChannelAck: (channelId: string, messageId: string) => void;
  onMarkUnread: (channelId: string, messageId: string) => void;
  removeChannelStates: (channelIds: Set<string>) => void;
  updateUserInMessages: (user: { id: string; [key: string]: any }) => void;
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
  scrollPositions: new Map(),

  saveScrollPosition: (channelId, messageId) => {
    set((state) => {
      const newPositions = new Map(state.scrollPositions);
      newPositions.set(channelId, messageId);
      return { scrollPositions: newPositions };
    });
  },

  setCurrentChannel: (channelId) => {
    set((state) => {
      const newAccessTimes = new Map(state.channelAccessTimes);
      if (channelId) {
        newAccessTimes.set(channelId, Date.now());
      }

      // Evict stale channels if we have too many cached
      let newMessages = state.messages;
      let newHasMore = state.hasMore;
      let newScrollPositions = state.scrollPositions;
      if (state.messages.size > MAX_CACHED_CHANNELS) {
        const entries = [...newAccessTimes.entries()]
          .filter(([id]) => id !== channelId)
          .sort((a, b) => a[1] - b[1]);
        const toEvict = state.messages.size - EVICT_TO_CHANNELS;
        const evictIds = new Set(entries.slice(0, toEvict).map(([id]) => id));
        if (evictIds.size > 0) {
          newMessages = new Map(state.messages);
          newHasMore = new Map(state.hasMore);
          newScrollPositions = new Map(state.scrollPositions);
          for (const id of evictIds) {
            newMessages.delete(id);
            newHasMore.delete(id);
            newAccessTimes.delete(id);
            newScrollPositions.delete(id);
          }
        }
      }

      return {
        currentChannelId: channelId,
        channelAccessTimes: newAccessTimes,
        messages: newMessages,
        hasMore: newHasMore,
        scrollPositions: newScrollPositions,
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
    scrollPositions: new Map(),
    currentChannelId: null,
    replyTo: null,
  }),

  loadMessages: async (channelId: string, force?: boolean) => {
    if (!force && get().hasMore.has(channelId)) return;
    const isDm = isDmChannel(channelId);
    // For server channels, bail if we don't know which instance owns this channel yet.
    // The remote WS ready handler will call loadMessages once the map is populated.
    if (!isDm && !useSpaceStore.getState().channelOriginMap.has(channelId)) return;
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

  loadMessagesAround: async (channelId: string, messageId: string) => {
    const isDm = isDmChannel(channelId);
    if (!isDm && !useSpaceStore.getState().channelOriginMap.has(channelId)) return;
    try {
      const origin = getChannelOrigin(channelId);
      const client = getApiForOrigin(origin);
      const messages = isDm
        ? await client.dm.messagesAround(channelId, messageId)
        : await client.channels.messagesAround(channelId, messageId);

      if (origin) {
        for (const msg of messages) normalizeMessageAssets(msg, origin);
      }

      set((state) => {
        const newMessages = new Map(state.messages);
        newMessages.set(channelId, messages as MessageWithUser[]);
        const newHasMore = new Map(state.hasMore);
        newHasMore.set(channelId, true);
        const newAccessTimes = new Map(state.channelAccessTimes);
        newAccessTimes.set(channelId, Date.now());
        return { messages: newMessages, hasMore: newHasMore, channelAccessTimes: newAccessTimes };
      });
    } catch (err) {
      console.error('Failed to load messages around:', err);
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
        content: content || null,
        replyToId: replyToId ?? null,
        editedAt: null,
        createdAt: Date.now(),
        user: currentUser,
        attachments: [],
        embeds: [],
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
        const { dmChannels, setDmChannels } = useSpaceStore.getState();
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
    const normalizedMessage = { ...message, embeds: message.embeds ?? [] };
    set((state) => {
      const newMessages = new Map(state.messages);
      const current = newMessages.get(channelId) ?? [];
      // Avoid duplicates
      if (current.find(m => m.id === normalizedMessage.id)) return state;
      // Remove any optimistic temp message with same content.
      // Don't require userId match — for federated messages the home user ID
      // differs from the replicated user ID, but content match is sufficient
      // since temp messages are unique within the short optimistic window.
      // Normalize both sides: empty string and null are equivalent (server stores null for empty content).
      const filtered = current.filter(m => {
        if (!m.id.startsWith('temp_')) return true;
        return (m.content || null) !== (normalizedMessage.content || null);
      });
      let updated = [...filtered, normalizedMessage];
      // Cap per-channel messages to prevent memory growth
      if (updated.length > MAX_MESSAGES_PER_CHANNEL) {
        updated = updated.slice(updated.length - MAX_MESSAGES_PER_CHANNEL);
      }
      newMessages.set(channelId, updated);
      return { messages: newMessages };
    });
  },

  addRealtimeMessage: (channelId: string, message: MessageWithUser) => {
    const normalizedMessage = { ...message, embeds: message.embeds ?? [] };
    set((state) => {
      const newMessages = new Map(state.messages);
      const current = newMessages.get(channelId) ?? [];
      // Avoid duplicates
      if (current.find(m => m.id === normalizedMessage.id)) return state;
      // Remove any optimistic temp message with same content (no userId check —
      // federated messages arrive with a different replicated user ID).
      // Normalize both sides: empty string and null are equivalent (server stores null for empty content).
      const filtered = current.filter(m => {
        if (!m.id.startsWith('temp_')) return true;
        return (m.content || null) !== (normalizedMessage.content || null);
      });
      let updated = [...filtered, normalizedMessage];
      // Cap per-channel messages to prevent memory growth
      if (updated.length > MAX_MESSAGES_PER_CHANNEL) {
        updated = updated.slice(updated.length - MAX_MESSAGES_PER_CHANNEL);
      }
      newMessages.set(channelId, updated);
      // Append to realtimeMessageEvents (capped at 50)
      const newEvents = [...state.realtimeMessageEvents, { channelId, message: normalizedMessage }];
      if (newEvents.length > 50) newEvents.splice(0, newEvents.length - 50);
      return { messages: newMessages, realtimeMessageEvents: newEvents };
    });
  },

  updateMessage: (message: MessageWithUser) => {
    // DM messages have dmChannelId instead of channelId — check both
    const channelKey = message.channelId || (message as any).dmChannelId;
    if (!channelKey) return;
    const normalizedMessage = { ...message, embeds: message.embeds ?? [] };
    set((state) => {
      const newMessages = new Map(state.messages);
      const current = newMessages.get(channelKey);
      if (!current) return state;
      newMessages.set(
        channelKey,
        current.map(m => m.id === normalizedMessage.id ? normalizedMessage : m),
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

  setReadStates: (readStates: ReadState[], channelLastMessageIds: Map<string, string>, originChannelIds?: Set<string>) => {
    // 1. Merge server read states into existing local state (preserves optimistic acks)
    const rsMap = new Map(get().readStates);
    for (const rs of readStates) {
      const local = rsMap.get(rs.channelId);
      if (!local) {
        rsMap.set(rs.channelId, rs.lastReadMessageId);
      } else {
        try {
          if (BigInt(rs.lastReadMessageId) > BigInt(local)) {
            rsMap.set(rs.channelId, rs.lastReadMessageId);
          }
        } catch {
          rsMap.set(rs.channelId, rs.lastReadMessageId);
        }
      }
    }

    // 2. Rebuild unreadChannels ONLY for channels from this origin
    //    Keep existing unread entries from other origins untouched,
    //    but prune orphans that don't map to any known channel
    const currentChannelId = get().currentChannelId;
    const { channelToSpaceMap, dmChannels: knownDms } = useSpaceStore.getState();
    const knownDmIds = new Set(knownDms.map(dm => dm.id));
    const unread = new Set<string>();
    for (const id of get().unreadChannels) {
      if (!originChannelIds || !originChannelIds.has(id)) {
        // Only preserve if the channel still maps to a known space or DM
        if (channelToSpaceMap.has(id) || knownDmIds.has(id)) {
          unread.add(id);
        }
      }
    }

    const channelsToCheck = originChannelIds ?? new Set(channelLastMessageIds.keys());
    for (const channelId of channelsToCheck) {
      if (channelId === currentChannelId) continue; // skip current channel (acked momentarily)
      const lastMsgId = channelLastMessageIds.get(channelId);
      if (!lastMsgId) continue; // empty channel
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

  markUnread: (channelId: string, messageId: string) => {
    // Optimistically update local state
    set((state) => {
      const newReadStates = new Map(state.readStates);
      const newUnread = new Set(state.unreadChannels);
      if (messageId === '0') {
        newReadStates.delete(channelId);
      } else {
        newReadStates.set(channelId, messageId);
      }
      newUnread.add(channelId);
      return { readStates: newReadStates, unreadChannels: newUnread };
    });

    // Send to the correct federated instance
    const origin = getChannelOrigin(channelId);
    wsSend({ type: 'mark_unread', channelId, messageId }, origin);
  },

  ackChannel: (channelId: string) => {
    const msgs = get().messages.get(channelId);
    if (!msgs || msgs.length === 0) return;

    // Walk backward to find the last server-confirmed (non-temp) message
    let messageId: string | null = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg && !msg.id.startsWith('temp_')) {
        messageId = msg.id;
        break;
      }
    }
    if (!messageId) return; // All messages are temp — nothing to ack yet

    // Update local state immediately
    set((state) => {
      const newReadStates = new Map(state.readStates);
      newReadStates.set(channelId, messageId!);
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

  onMarkUnread: (channelId: string, messageId: string) => {
    set((state) => {
      const newReadStates = new Map(state.readStates);
      const newUnread = new Set(state.unreadChannels);
      if (messageId === '0') {
        newReadStates.delete(channelId);
      } else {
        newReadStates.set(channelId, messageId);
      }
      newUnread.add(channelId);
      return { readStates: newReadStates, unreadChannels: newUnread };
    });
  },

  removeChannelStates: (channelIds: Set<string>) => {
    if (channelIds.size === 0) return;
    set((state) => {
      const newUnread = new Set(state.unreadChannels);
      const newReadStates = new Map(state.readStates);
      const newMessages = new Map(state.messages);
      for (const channelId of channelIds) {
        newUnread.delete(channelId);
        newReadStates.delete(channelId);
        newMessages.delete(channelId);
      }
      return { unreadChannels: newUnread, readStates: newReadStates, messages: newMessages };
    });
  },

  updateUserInMessages: (user: { id: string; homeUserId?: string | null; [key: string]: any }) => {
    set((state) => {
      const newMessages = new Map(state.messages);
      let changed = false;
      for (const [channelId, msgs] of newMessages) {
        let channelChanged = false;
        const updated = msgs.map(m => {
          const matches = m.userId === user.id ||
            (user.homeUserId && m.user?.homeUserId && m.user.homeUserId === user.homeUserId);
          if (matches) {
            channelChanged = true;
            return { ...m, user: { ...m.user, ...user } };
          }
          return m;
        });
        if (channelChanged) { newMessages.set(channelId, updated); changed = true; }
      }
      return changed ? { messages: newMessages } : {};
    });
  },
}));
