import { receiveChannelPoke } from '../components/chat/channelPoke';
import { useChannelActivityStore } from '../stores/channelActivityStore';
import { useChatStore } from '../stores/chatStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import type { WebSocketEventHandlers } from './webSocketEvents';

export const miscEvents = {
  notification_setting_updated: (origin, event) => {
    useNotificationStore.getState().apply(origin, event.setting);
  },
  channel_unread_count: (origin, event) => {
    useChannelActivityStore.getState().updateCounts(origin, event.counts);
  },
  channel_poke_failed: (origin, event) => {
    useUIStore.getState().addToast(event.message, 'warning');
  },
  channel_poke: (origin, event) => {
    receiveChannelPoke(origin, event);
  },
  mark_unread: (origin, event) => {
    const { onMarkUnread } = useChatStore.getState();
    onMarkUnread(event.channelId, event.messageId);
  },
  channel_layout_updated: (origin, event) => {
    const { currentSpaceId } = useSpaceStore.getState();
    const { currentSpaceId: layoutSpaceId, setChannels: setLayoutChannels, setCategories: setLayoutCategories, channelPermissions: layoutChPerms, channelToSpaceMap: layoutCtsMap, channelOriginMap: layoutCoMap } = useSpaceStore.getState();
    if (event.spaceId === layoutSpaceId) {
      setLayoutChannels(event.channels.sort((a, b) => a.position - b.position));
      setLayoutCategories(event.categories.sort((a, b) => a.position - b.position));
      // Update permission maps from the new layout
      for (const ch of event.channels) {
        layoutCtsMap.set(ch.id, event.spaceId);
        layoutCoMap.set(ch.id, origin);
        if (ch.myPermissions) {
          layoutChPerms.set(ch.id, ch.myPermissions);
        }
      }
    }
  },
  pong: (origin, event) => {

  },
  error: (origin, event) => {
    console.error(`WebSocket error (${origin || 'home'}):`, event.message);
  },
} satisfies WebSocketEventHandlers;
