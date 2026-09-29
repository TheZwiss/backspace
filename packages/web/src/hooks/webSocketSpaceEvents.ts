import { useChatStore } from '../stores/chatStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { resolveAssetUrl } from '../utils/assetUrls';
import type { WebSocketEventHandlers } from './webSocketEvents';

export const spaceEvents = {
  channel_created: (origin, event) => {
    useSpaceStore.getState().upsertChannel(event.channel, event.spaceId, origin);
  },
  channel_updated: (origin, event) => {
    const { currentSpaceId } = useSpaceStore.getState();
    const { currentSpaceId: curSpaceId2, channels: curChannels2, setChannels: setChannels2, channelPermissions: chPermsMap2 } = useSpaceStore.getState();
    if (event.spaceId === curSpaceId2) {
      const exists = curChannels2.some(c => c.id === event.channel.id);
      if (exists) {
        setChannels2(curChannels2.map(c => c.id === event.channel.id ? event.channel : c).sort((a, b) => a.position - b.position));
      } else {
        setChannels2([...curChannels2, event.channel].sort((a, b) => a.position - b.position));
        const { channelToSpaceMap: ctsMmap, channelOriginMap: coMap } = useSpaceStore.getState();
        ctsMmap.set(event.channel.id, event.spaceId);
        coMap.set(event.channel.id, origin);
      }
    }
    if (event.channel.myPermissions) {
      chPermsMap2.set(event.channel.id, event.channel.myPermissions);
    }
  },
  channel_deleted: (origin, event) => {
    const { currentSpaceId } = useSpaceStore.getState();
    const { currentSpaceId: curSpaceId3, channels: curChannels3, setChannels: setChannels3, channelPermissions: chPermsMap3, channelToSpaceMap: ctsMap3, channelOriginMap: coMap3 } = useSpaceStore.getState();
    if (event.spaceId === curSpaceId3) {
      setChannels3(curChannels3.filter(c => c.id !== event.channelId));
    }
    // If the user is currently viewing the deleted channel, clear it
    const { currentChannelId: deletedViewChannelId } = useChatStore.getState();
    if (deletedViewChannelId === event.channelId) {
      useChatStore.getState().setCurrentChannel(null);
    }
    chPermsMap3.delete(event.channelId);
    ctsMap3.delete(event.channelId);
    coMap3.delete(event.channelId);
    // Clean up unread and read state for the deleted channel
    {
      const { channelLastMessageIds: clmIds } = useSpaceStore.getState();
      clmIds.delete(event.channelId);
      const cs = useChatStore.getState();
      if (cs.unreadChannels.has(event.channelId) || cs.readStates.has(event.channelId)) {
        const newUnread = new Set(cs.unreadChannels);
        newUnread.delete(event.channelId);
        const newRS = new Map(cs.readStates);
        newRS.delete(event.channelId);
        useChatStore.setState({ unreadChannels: newUnread, readStates: newRS });
      }
    }
    // Clean up voice users for the deleted channel
    {
      const vs = useVoiceStore.getState();
      if (vs.voiceUsers.has(event.channelId) || vs.voiceChannelElapsedSeconds.has(event.channelId)) {
        const newVoiceUsers = new Map(vs.voiceUsers);
        const voiceChannelElapsedSeconds = new Map(vs.voiceChannelElapsedSeconds);
        newVoiceUsers.delete(event.channelId);
        voiceChannelElapsedSeconds.delete(event.channelId);
        useVoiceStore.setState({ voiceUsers: newVoiceUsers, voiceChannelElapsedSeconds });
      }
    }
  },
  space_updated: (origin, event) => {
    const isHome = origin === '';
    if (!isHome && event.space.icon) {
      event.space.icon = resolveAssetUrl(event.space.icon, origin) ?? event.space.icon;
    }
    if (!isHome && event.space.banner) {
      event.space.banner = resolveAssetUrl(event.space.banner, origin) ?? event.space.banner;
    }
    const { spaces: currentSpaces, setSpaces } = useSpaceStore.getState();
    setSpaces(currentSpaces.map(s => s.id === event.space.id ? { ...s, ...event.space } : s));
  },
  category_created: (origin, event) => {
    const { currentSpaceId } = useSpaceStore.getState();
    const { currentSpaceId: catSpaceId, categories: curCategories, setCategories: setCats, categoryOriginMap: catOriginMap } = useSpaceStore.getState();
    catOriginMap.set(event.category.id, origin);
    if (event.spaceId === catSpaceId) {
      if (!curCategories.some(c => c.id === event.category.id)) {
        setCats([...curCategories, event.category].sort((a, b) => a.position - b.position));
      }
    }
  },
  category_updated: (origin, event) => {
    const { currentSpaceId } = useSpaceStore.getState();
    const { currentSpaceId: catSpaceId2, categories: curCategories2, setCategories: setCats2 } = useSpaceStore.getState();
    if (event.spaceId === catSpaceId2) {
      setCats2(curCategories2.map(c => c.id === event.category.id ? event.category : c).sort((a, b) => a.position - b.position));
    }
  },
  category_deleted: (origin, event) => {
    const { currentSpaceId } = useSpaceStore.getState();
    const { currentSpaceId: catSpaceId3, categories: curCategories3, setCategories: setCats3, channels: curChsForCat, setChannels: setChsForCat, categoryOriginMap: catOriginMap3 } = useSpaceStore.getState();
    catOriginMap3.delete(event.categoryId);
    if (event.spaceId === catSpaceId3) {
      setCats3(curCategories3.filter(c => c.id !== event.categoryId));
      // Null out categoryId on affected channels (server already did this, but sync local state)
      setChsForCat(curChsForCat.map(ch => ch.categoryId === event.categoryId ? { ...ch, categoryId: null } : ch));
    }
  },
  space_layout_updated: (origin, event) => {
    // LWW: only accept if incoming timestamp >= current
    const incomingTs = event.updatedAt ?? 0;
    const currentTs = useSpaceStore.getState()._layoutUpdatedAt;
    if (incomingTs >= currentTs) {
      useSpaceStore.getState().setSpaceLayout(event.layout);
      useSpaceStore.setState({ folders: event.folders, _layoutUpdatedAt: incomingTs });
    }
  },
  join_request_received: (origin, event) => {
    const isHome = origin === '';
    if (!isHome) return;
    console.log('[WebSocket] Join request received from', event.request.user?.username ?? event.request.userId);
  },
  join_request_accepted: (origin, event) => {
    const isHome = origin === '';
    if (!isHome) return;
    // Add the space to our space list
    const { addSpaceFromReady } = useSpaceStore.getState();
    addSpaceFromReady(origin, event.space);
    console.log('[WebSocket] Join request accepted for space', event.space.name);
  },
  join_request_declined: (origin, event) => {
    const isHome = origin === '';
    if (!isHome) return;
    console.log('[WebSocket] Join request declined for space', event.request.spaceId);
  },
} satisfies WebSocketEventHandlers;
