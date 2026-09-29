import type { DmMessageWithUser, MessageWithUser } from '@backspace/shared';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { normalizeMessageAssets, normalizeUserAssets, resolveAssetUrl } from '../utils/assetUrls';
import { applyIncomingDmChannel, applyIncomingDmMessage } from '../utils/dmMessageRouting';
import type { WebSocketEventHandlers } from './webSocketEvents';
import { activePeerOrigins } from './webSocketFederationEvents';

// Channel and DM events share asset normalization and identity caching.
function prepareIncomingMessage(origin: string, message: MessageWithUser | DmMessageWithUser): void {
  if (origin !== '') {
    normalizeMessageAssets(message, origin);
    for (const embed of message.embeds ?? []) {
      if (embed.image && !embed.image.startsWith('http')) {
        embed.image = resolveAssetUrl(embed.image, origin) ?? embed.image;
      }
    }
  }
  const { upsertUserView } = useSpaceStore.getState();
  if (message.user) upsertUserView(message.user, origin);
  if (message.replyTo?.user) upsertUserView(message.replyTo.user, origin);
}

export const chatEvents = {
  message_created: (origin, event) => {
    const isHome = origin === '';
    const { addRealtimeMessage } = useChatStore.getState();
    prepareIncomingMessage(origin, event.message);
    addRealtimeMessage(event.message.channelId, event.message);
    {
      const { currentChannelId, markChannelUnread } = useChatStore.getState();
      const { voiceChannelIds } = useSpaceStore.getState();
      const myId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
      // Skip voice channels — they have no text reading/acking UI
      if (event.message.type !== 'system' && event.message.channelId !== currentChannelId && event.message.userId !== myId && !voiceChannelIds.has(event.message.channelId)) {
        markChannelUnread(event.message.channelId);
      }
    }
  },
  message_updated: (origin, event) => {
    const { updateMessage } = useChatStore.getState();
    prepareIncomingMessage(origin, event.message);
    updateMessage(event.message);
  },
  message_deleted: (origin, event) => {
    const { removeMessage } = useChatStore.getState();
    removeMessage(event.messageId, event.channelId);
  },
  typing: (origin, event) => {
    const isHome = origin === '';
    const { setTyping } = useChatStore.getState();
    let typingUsername = event.username as string;
    if (!isHome && typingUsername && !typingUsername.includes('@')) {
      try { typingUsername = `${typingUsername}@${new URL(origin).host}`; } catch { }
    }
    setTyping(event.channelId, event.userId, typingUsername);
  },
  dm_message_created: (origin, event) => {
    const isHome = origin === '';
    // Gate: only process DM events from the home instance or actively peered origins.
    // This prevents notifications/previews from remote instances where S2S peering
    // was revoked, deleted, or never established — even if the client still has a
    // direct WS connection to that instance via Connections.
    if (!isHome && !activePeerOrigins.has(origin)) {
      return;
    }
    prepareIncomingMessage(origin, event.message);
    void applyIncomingDmMessage(origin, event.message);
  },
  dm_message_updated: (origin, event) => {
    const isHome = origin === '';
    const { updateMessage } = useChatStore.getState();
    if (!isHome && !activePeerOrigins.has(origin)) return;
    prepareIncomingMessage(origin, event.message);
    updateMessage(event.message as any);
  },
  dm_message_deleted: (origin, event) => {
    const isHome = origin === '';
    const { removeMessage } = useChatStore.getState();
    if (!isHome && !activePeerOrigins.has(origin)) return;
    removeMessage(event.messageId, event.dmChannelId);
  },
  embeds_resolved: (origin, event) => {
    const isHome = origin === '';
    if (!isHome) {
      for (const embed of event.embeds) {
        if (embed.image && !embed.image.startsWith('http')) {
          embed.image = resolveAssetUrl(embed.image, origin) ?? embed.image;
        }
      }
    }
    const resolvedMsgs = useChatStore.getState().messages.get(event.channelId);
    if (resolvedMsgs) {
      const newResolvedMsgs = resolvedMsgs.map(m =>
        m.id === event.messageId ? { ...m, embeds: event.embeds } : m
      );
      const newResolvedMessages = new Map(useChatStore.getState().messages);
      newResolvedMessages.set(event.channelId, newResolvedMsgs);
      useChatStore.setState({ messages: newResolvedMessages });
    }
  },
  dm_embeds_resolved: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    if (!isHome) {
      for (const embed of event.embeds) {
        if (embed.image && !embed.image.startsWith('http')) {
          embed.image = resolveAssetUrl(embed.image, origin) ?? embed.image;
        }
      }
    }
    const dmResolvedMsgs = useChatStore.getState().messages.get(event.dmChannelId);
    if (dmResolvedMsgs) {
      const newDmResolvedMsgs = dmResolvedMsgs.map(m =>
        m.id === event.messageId ? { ...m, embeds: event.embeds } : m
      );
      const newDmResolvedMessages = new Map(useChatStore.getState().messages);
      newDmResolvedMessages.set(event.dmChannelId, newDmResolvedMsgs);
      useChatStore.setState({ messages: newDmResolvedMessages });
    }
  },
  dm_typing: (origin, event) => {
    const isHome = origin === '';
    const { setTyping } = useChatStore.getState();
    if (!isHome && !activePeerOrigins.has(origin)) return;
    let dmTypingUsername = event.username as string;
    if (!isHome && dmTypingUsername && !dmTypingUsername.includes('@')) {
      try { dmTypingUsername = `${dmTypingUsername}@${new URL(origin).host}`; } catch { }
    }
    setTyping(event.dmChannelId, event.userId, dmTypingUsername);
  },
  dm_typing_stop: (origin, event) => {
    const isHome = origin === '';
    const { clearTyping } = useChatStore.getState();
    if (!isHome && !activePeerOrigins.has(origin)) return;
    clearTyping(event.dmChannelId as string, event.userId as string);
  },
  reaction_added: (origin, event) => {
    const { onReactionAdded } = useChatStore.getState();
    onReactionAdded(event.messageId, event.reaction);
  },
  reaction_removed: (origin, event) => {
    const { onReactionRemoved } = useChatStore.getState();
    onReactionRemoved(event.messageId, event.userId, event.emoji);
  },
  channel_ack: (origin, event) => {
    const { onChannelAck } = useChatStore.getState();
    onChannelAck(event.channelId, event.messageId);
  },
  dm_channel_created: (origin, event) => {
    const isHome = origin === '';
    const { upsertUserView } = useSpaceStore.getState();
    if (!isHome && !activePeerOrigins.has(origin)) return;
    if (!isHome) {
      for (const m of event.dmChannel.members) {
        normalizeUserAssets(m, origin);
      }
    }
    for (const m of event.dmChannel.members) {
      upsertUserView(m, origin);
    }
    applyIncomingDmChannel(origin, event.dmChannel);
  },
  dm_channel_closed: (origin, event) => {
    const isHome = origin === '';
    const { removeDmChannel } = useSpaceStore.getState();
    if (!isHome && !activePeerOrigins.has(origin)) return;
    removeDmChannel(event.dmChannelId);
  },
  dm_member_added: (origin, event) => {
    const isHome = origin === '';
    const { upsertUserView } = useSpaceStore.getState();
    if (!isHome && !activePeerOrigins.has(origin)) return;
    if (!isHome) normalizeUserAssets(event.user, origin);
    upsertUserView(event.user, origin);
    const { addDmMember } = useSpaceStore.getState();
    addDmMember(event.dmChannelId, event.user);
  },
  dm_member_removed: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    const { removeDmMember } = useSpaceStore.getState();
    removeDmMember(event.dmChannelId, event.userId);
  },
  dm_owner_updated: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    const { updateDmOwner } = useSpaceStore.getState();
    // Pass the federation routing fields so the DM's `ownerHomeInstance`
    // stays in sync with the server. Without this, `getOwnerInstanceForDm`
    // routes the next owner-only API call (rename, icon, kick, transfer)
    // through the PREVIOUS owner's home instance and the receiving peer
    // rejects it as `unauthorized_source`. Older servers omit these fields
    // — the store leaves the existing values untouched in that case.
    updateDmOwner(
      event.dmChannelId,
      event.newOwnerId,
      event.newOwnerHomeUserId ?? undefined,
      event.newOwnerHomeInstance ?? undefined,
    );
  },
  dm_channel_updated: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && !activePeerOrigins.has(origin)) return;
    const { dmChannelId, name, icon } = event;
    useSpaceStore.getState().updateDmMetadata(dmChannelId, { name, icon });
  },
} satisfies WebSocketEventHandlers;
