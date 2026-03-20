import React, { useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useSpaceStore, getChannelOrigin, getMyUserIdForOrigin, setMyUserIdForOrigin } from '../stores/spaceStore';
import { useChatStore } from '../stores/chatStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useSocialStore } from '../stores/socialStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { ServerEvent, ClientEvent, ActiveCallInfo } from '@backspace/shared';
import { resolveAssetUrl, normalizeUserAssets, normalizeMessageAssets } from '../utils/assetUrls';
import { broadcastVoiceStatus, broadcastDeafenViaLiveKit } from '../utils/voice';
import { registerSelfId } from '../utils/identity';
import { getActiveRoom } from './useLiveKit';
import { useUIStore } from '../stores/uiStore';

// ─── Connection state ─────────────────────────────────────────────────────────

interface ConnectionState {
  ws: WebSocket | null;
  heartbeatWorker: Worker | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  token: string;
}

// '' = home instance, 'https://remote.example.com' = remote
const connections = new Map<string, ConnectionState>();

// Track whether the home connection has been initialized via the React hook
let homeInitialized = false;

// ─── Heartbeat (Web Worker) ───────────────────────────────────────────────────

function createHeartbeatWorker(): Worker {
  const blob = new Blob([`
    let timerId = null;
    self.onmessage = function(e) {
      if (e.data === 'start') {
        if (timerId) clearInterval(timerId);
        timerId = setInterval(function() { self.postMessage('tick'); }, 15000);
      } else if (e.data === 'stop') {
        if (timerId) { clearInterval(timerId); timerId = null; }
      }
    };
  `], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
}

function startHeartbeat(conn: ConnectionState): void {
  stopHeartbeat(conn);
  conn.heartbeatWorker = createHeartbeatWorker();
  conn.heartbeatWorker.onmessage = () => {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({ type: 'ping' }));
    }
  };
  conn.heartbeatWorker.postMessage('start');
}

function stopHeartbeat(conn: ConnectionState): void {
  if (conn.heartbeatWorker) {
    conn.heartbeatWorker.postMessage('stop');
    conn.heartbeatWorker.terminate();
    conn.heartbeatWorker = null;
  }
}

// ─── WS URL construction ─────────────────────────────────────────────────────

function buildWsUrl(origin: string): string {
  if (!origin) {
    // Home instance — derive from current page
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }
  // Remote instance — derive from origin URL
  const url = new URL(origin);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/ws`;
}

// ─── Event handling ───────────────────────────────────────────────────────────

const HOME_ORIGIN = '';

function handleEvent(origin: string, event: ServerEvent): void {
  const isHome = origin === HOME_ORIGIN;
  const { setUser } = useAuthStore.getState();
  const { populateFromReady, loadSpaceDetail, currentSpaceId, updateMemberPresence, addMember, removeMember, addDmChannel, removeDmChannel } = useSpaceStore.getState();
  const { addMessage, addRealtimeMessage, updateMessage, removeMessage, setTyping, onReactionAdded, onReactionRemoved } = useChatStore.getState();
  const { addVoiceUser, removeVoiceUser, clearVoiceUsersForOrigin, setVoiceUsers, setVoiceUserStatus, clearVoiceUserStatus } = useVoiceStore.getState();

  switch (event.type) {
    case 'ready':
      // Register this user's ID for cross-instance self-identification
      registerSelfId(event.user.id);

      if (isHome) {
        setUser(event.user);
        useSettingsStore.getState().setIsAdmin(event.user.isAdmin ?? false);
        useSettingsStore.getState().fetchStreamingLimits();
        useSettingsStore.getState().fetchGifEnabled();
      }

      // Normalize asset URLs for remote origins before dispatching to stores
      if (!isHome) {
        for (const space of event.spaces) {
          if (space.icon) space.icon = resolveAssetUrl(space.icon, origin) ?? space.icon;
          if (space.banner) space.banner = resolveAssetUrl(space.banner, origin) ?? space.banner;
          if ((space as any).members) {
            for (const member of (space as any).members) {
              if (member.user) normalizeUserAssets(member.user, origin);
            }
          }
        }
      }

      populateFromReady(origin, event.spaces, event.folders, event.dmChannels, event.spaceLayout, event.layoutUpdatedAt);

      // Cache authoritative identity for this origin (federation-safe)
      if (!isHome) {
        setMyUserIdForOrigin(origin, event.user.id);
      }

      // Mark remote instance as connected in instanceStore
      if (!isHome) {
        import('../stores/instanceStore').then(({ useInstanceStore }) => {
          useInstanceStore.getState().setInstanceStatus(origin, 'connected');
        });
      }

      if (isHome && currentSpaceId) {
        loadSpaceDetail(currentSpaceId);
      }

      // For remote instances: if user was viewing one of these servers, load its details
      // (fixes race condition on page reload — route params effect fires before remote WS connects)
      if (!isHome) {
        const { currentSpaceId: curSpaceId, loadSpaceDetail: loadDetail } = useSpaceStore.getState();
        if (curSpaceId && event.spaces.some((s: any) => s.id === curSpaceId)) {
          loadDetail(curSpaceId);
          const { currentChannelId, loadMessages } = useChatStore.getState();
          if (currentChannelId) {
            loadMessages(currentChannelId, true);
          }
        }
      }

      // Clear stale message cache for all channels on this origin so the next
      // visit does a fresh fetch (and scroll-to-bottom fires correctly).
      // Force-reload the currently open channel immediately.
      {
        const chatState = useChatStore.getState();
        const { channelOriginMap } = useSpaceStore.getState();
        const newMessages = new Map(chatState.messages);
        const newHasMore = new Map(chatState.hasMore);
        for (const [channelId, chOrigin] of channelOriginMap) {
          if (chOrigin === origin) {
            newMessages.delete(channelId);
            newHasMore.delete(channelId);
          }
        }
        if (isHome) {
          for (const key of [...newMessages.keys()]) {
            if (key.startsWith('dm-')) {
              newMessages.delete(key);
              newHasMore.delete(key);
            }
          }
        }
        useChatStore.setState({ messages: newMessages, hasMore: newHasMore });
        if (chatState.currentChannelId) {
          chatState.loadMessages(chatState.currentChannelId, true);
        }
      }

      // Initialize/update unread tracking for this origin (home or remote)
      if (event.readStates) {
        const { channelLastMessageIds, channelOriginMap } = useSpaceStore.getState();
        const originChannelIds = new Set<string>();
        for (const [channelId, chOrigin] of channelOriginMap) {
          if (chOrigin === origin) originChannelIds.add(channelId);
        }
        useChatStore.getState().setReadStates(event.readStates, channelLastMessageIds, originChannelIds);
      }

      // Prune orphaned unreads: channels in unreadChannels that don't map to
      // any known space channel or DM (e.g. deleted channels, revoked permissions)
      {
        const { unreadChannels: uc } = useChatStore.getState();
        const { channelToSpaceMap: ctsMap, dmChannels: dms } = useSpaceStore.getState();
        const dmIds = new Set(dms.map(d => d.id));
        const orphanIds = new Set<string>();
        for (const id of uc) {
          if (!ctsMap.has(id) && !dmIds.has(id)) orphanIds.add(id);
        }
        if (orphanIds.size > 0) {
          useChatStore.getState().removeChannelStates(orphanIds);
        }
      }

      // Clear voice state only for the reconnecting origin before repopulating
      clearVoiceUsersForOrigin(origin);
      if (event.voiceStates) {
        for (const [channelId, userIds] of Object.entries(event.voiceStates)) {
          setVoiceUsers(channelId, userIds);
        }
      }
      // Populate voice user statuses (mute/deafen/camera/screenshare) from server
      if (event.voiceUserStates) {
        for (const [uid, status] of Object.entries(event.voiceUserStates)) {
          setVoiceUserStatus(uid, status.isMuted, status.isDeafened, status.isCameraOn, status.isScreenSharing);
        }
      }
      // Build new restriction Sets atomically from ready payload, then apply in one setState
      {
        const vsState = useVoiceStore.getState();
        const spaceStoreState = useSpaceStore.getState();
        
        // Find all space IDs that belong to the current origin
        const originSpaceIds = new Set<string>();
        for (const s of spaceStoreState.spaces) {
          if (s._instanceOrigin === origin) {
            originSpaceIds.add(s.id);
          }
        }

        const nextSpaceMuted = new Set(vsState.spaceMutedUserIds);
        const nextSpaceDeafened = new Set(vsState.spaceDeafenedUserIds);
        const nextPermissionMuted = new Set(vsState.permissionMutedUserIds);

        // Clear existing restrictions that belong to spaces on THIS origin
        // (If a space was deleted while offline, its orphaned restrictions remain, which is harmless)
        for (const key of nextSpaceMuted) {
          const spaceId = key.split(':')[0];
          if (spaceId && originSpaceIds.has(spaceId)) nextSpaceMuted.delete(key);
        }
        for (const key of nextSpaceDeafened) {
          const spaceId = key.split(':')[0];
          if (spaceId && originSpaceIds.has(spaceId)) nextSpaceDeafened.delete(key);
        }
        for (const key of nextPermissionMuted) {
          const spaceId = key.split(':')[0];
          if (spaceId && originSpaceIds.has(spaceId)) nextPermissionMuted.delete(key);
        }

        if (event.spaceVoiceStates) {
          for (const [uid, state] of Object.entries(event.spaceVoiceStates as Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted?: boolean }>)) {
            if (state.spaceMuted) nextSpaceMuted.add(uid);
            if (state.spaceDeafened) nextSpaceDeafened.add(uid);
            if (state.permissionMuted) nextPermissionMuted.add(uid);
          }
        }
        // Single atomic update
        useVoiceStore.setState({ spaceMutedUserIds: nextSpaceMuted, spaceDeafenedUserIds: nextSpaceDeafened, permissionMutedUserIds: nextPermissionMuted });

        // With decoupled state, user intent is never force-set by the server.
        // Effective state (intent || serverEnforcement) is computed reactively
        // at broadcast and hardware time.
      }

      // Re-register in voice channel after WS reconnect — the server lost
      // voice state on restart, so we must tell it we're still connected.
      // GUARD: Only re-register if LiveKit is actually connected. Background
      // tabs can reconnect WS but not LiveKit — sending voice_join without
      // an active media plane would create ghost users in the sidebar.
      {
        const { currentVoiceChannelId, isLiveKitConnected } = useVoiceStore.getState();
        if (currentVoiceChannelId && isLiveKitConnected) {
          const voiceOrigin = getChannelOrigin(currentVoiceChannelId);
          if (voiceOrigin === origin) {
            const myId = event.user.id;
            if (myId) addVoiceUser(currentVoiceChannelId, myId);
            wsSend({ type: 'voice_join', channelId: currentVoiceChannelId }, origin);
            broadcastVoiceStatus(origin);
          }
        }
      }

      // Restore DM call state from server (all origins — federated DMs live on remote instances)
      {
        const { activeDmCall, setActiveDmCall, setIncomingCall, incomingCall } = useVoiceStore.getState();
        const myId = event.user.id;
        if (event.activeCalls && event.activeCalls.length > 0) {
          for (const call of event.activeCalls) {
            const isParticipant = call.participants.includes(myId);
            if (call.state === 'active' && isParticipant) {
              setActiveDmCall({ dmChannelId: call.dmChannelId });
              break;
            } else if (call.state === 'ringing' && call.callerId !== myId) {
              const dmCh = event.dmChannels?.find((d: any) => d.id === call.dmChannelId);
              const callerUser = dmCh?.members?.find((m: any) => m.id === call.callerId);
              setIncomingCall({
                dmChannelId: call.dmChannelId,
                callerId: call.callerId,
                callerName: callerUser?.displayName || callerUser?.username || call.callerId,
              });
            }
          }
        } else {
          if (activeDmCall) {
            setActiveDmCall(null);
          }
          if (incomingCall) {
            setIncomingCall(null);
          }
        }
      }

      // Load social data so profile modals show correct friendship state.
      // Runs on each ready (home + remote) — loadFriends/loadRequests fan out
      // across all connected instances and replace the arrays (idempotent).
      {
        const { loadFriends, loadRequests } = useSocialStore.getState();
        loadFriends();
        loadRequests();
      }
      break;

    case 'message_created':
      if (!isHome) {
        normalizeMessageAssets(event.message, origin);
        if (event.message.embeds) {
          for (const embed of event.message.embeds) {
            if (embed.image && !embed.image.startsWith('http')) {
              embed.image = resolveAssetUrl(embed.image, origin) ?? embed.image;
            }
          }
        }
      }
      addRealtimeMessage(event.message.channelId, event.message);
      {
        const { currentChannelId, markChannelUnread } = useChatStore.getState();
        const { voiceChannelIds } = useSpaceStore.getState();
        const myId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
        // Skip voice channels — they have no text reading/acking UI
        if (event.message.channelId !== currentChannelId && event.message.userId !== myId && !voiceChannelIds.has(event.message.channelId)) {
          markChannelUnread(event.message.channelId);
        }
      }
      break;

    case 'message_updated':
      if (!isHome) {
        normalizeMessageAssets(event.message, origin);
        if (event.message.embeds) {
          for (const embed of event.message.embeds) {
            if (embed.image && !embed.image.startsWith('http')) {
              embed.image = resolveAssetUrl(embed.image, origin) ?? embed.image;
            }
          }
        }
      }
      updateMessage(event.message);
      break;

    case 'message_deleted':
      removeMessage(event.messageId, event.channelId);
      break;

    case 'typing': {
      let typingUsername = event.username as string;
      if (!isHome && typingUsername && !typingUsername.includes('@')) {
        try { typingUsername = `${typingUsername}@${new URL(origin).host}`; } catch {}
      }
      setTyping(event.channelId, event.userId, typingUsername);
      break;
    }

    case 'presence_update':
      updateMemberPresence(event.userId, event.status);
      useSocialStore.getState().updateFriendPresence(event.userId, event.status);
      break;

    case 'user_updated': {
      if (!isHome) normalizeUserAssets(event.user, origin);
      useSpaceStore.getState().updateUserEverywhere(event.user);
      useSocialStore.getState().updateFriendProfile(event.user);
      useChatStore.getState().updateUserInMessages(event.user);
      // If this is the current user (other tab changed profile), update authStore
      const myId = isHome
        ? useAuthStore.getState().user?.id
        : getMyUserIdForOrigin(origin);
      if (event.user.id === myId && isHome) {
        setUser(event.user);
      }
      break;
    }

    case 'voice_state_update':
      if (event.action === 'join') {
        addVoiceUser(event.channelId, event.userId);
      } else {
        removeVoiceUser(event.channelId, event.userId);
        clearVoiceUserStatus(event.userId);
      }
      break;

    case 'voice_status_update':
      setVoiceUserStatus(event.userId, event.isMuted, event.isDeafened, event.isCameraOn, event.isScreenSharing);
      break;

    case 'voice_space_muted': {
      const { setSpaceMutedUser } = useVoiceStore.getState();
      setSpaceMutedUser(event.spaceId, event.userId, event.muted);
      // Broadcast effective state if this targets the current user
      const myMuteId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
      if (event.userId === myMuteId) broadcastVoiceStatus();
      break;
    }

    case 'voice_permission_muted': {
      const { setPermissionMutedUser } = useVoiceStore.getState();
      setPermissionMutedUser(event.spaceId, event.userId, event.muted);
      const myPermMuteId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
      if (event.userId === myPermMuteId) broadcastVoiceStatus();
      break;
    }

    case 'voice_space_deafened': {
      const { setSpaceDeafenedUser } = useVoiceStore.getState();
      setSpaceDeafenedUser(event.spaceId, event.userId, event.deafened);
      // Broadcast effective state if this targets the current user
      const myDeafenId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
      if (event.userId === myDeafenId) {
        broadcastVoiceStatus();
        broadcastDeafenViaLiveKit();
      }
      break;
    }

    case 'voice_moved': {
      // The local user was moved to a different channel by a moderator
      const myMovedId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
      if (event.userId === myMovedId) {
        // Import dynamically to avoid circular deps — joinVoiceChannel handles
        // leaving old channel, setting new channel, and triggering LiveKit reconnect
        import('../utils/voice').then(({ joinVoiceChannel }) => {
          // Force-set the channel (joinVoiceChannel skips if same channel)
          const vs = useVoiceStore.getState();
          // Clear current channel first so joinVoiceChannel doesn't bail
          vs.setCurrentVoiceChannel(null);
          joinVoiceChannel(event.newChannelId);
        });
      }
      break;
    }

    case 'voice_disconnected': {
      const myDisconnectId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
      if (event.userId === myDisconnectId) {
        const { currentVoiceChannelId } = useVoiceStore.getState();
        if (event.channelId === currentVoiceChannelId) {
          useVoiceStore.getState().handleForceDisconnect();
          getActiveRoom()?.disconnect();
          if (event.reason === 'displaced') {
            useUIStore.getState().addToast('Voice disconnected — joined from another session', 'info');
          }
        }
      }
      break;
    }

    case 'member_joined':
      if (!isHome) normalizeUserAssets(event.member.user, origin);
      addMember(event.member);
      break;

    case 'member_left':
      removeMember(event.userId);
      break;

    case 'member_banned': {
      // The current user has been banned from a space — remove it from the sidebar
      const { removeSpace: rmSpace } = useSpaceStore.getState();
      rmSpace(event.spaceId);
      break;
    }

    // ─── DM events (home-only) ──────────────────────────────────────────────

    case 'dm_message_created': {
      if (!isHome) {
        normalizeMessageAssets(event.message as any, origin);
        if ((event.message as any).embeds) {
          for (const embed of (event.message as any).embeds) {
            if (embed.image && !embed.image.startsWith('http')) {
              embed.image = resolveAssetUrl(embed.image, origin) ?? embed.image;
            }
          }
        }
      }
      addRealtimeMessage(event.message.dmChannelId, event.message as any);
      const { dmChannels: currentDmChannels, setDmChannels: setDms, addDmChannel: addDmCh } = useSpaceStore.getState();
      const knownDm = currentDmChannels.find(dm => dm.id === event.message.dmChannelId);
      if (!knownDm) {
        addDmCh({
          id: event.message.dmChannelId,
          createdAt: event.message.createdAt,
          members: event.message.user ? [event.message.user] : [],
          lastMessage: event.message,
        }, origin);
      } else {
        const updatedDms = currentDmChannels.map(dm =>
          dm.id === event.message.dmChannelId
            ? { ...dm, lastMessage: event.message }
            : dm
        );
        updatedDms.sort((a, b) => {
          const aTime = a.lastMessage?.createdAt ?? a.createdAt;
          const bTime = b.lastMessage?.createdAt ?? b.createdAt;
          return bTime - aTime;
        });
        setDms(updatedDms);
      }
      {
        const { currentChannelId, markChannelUnread } = useChatStore.getState();
        const myId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
        if (event.message.dmChannelId !== currentChannelId && event.message.userId !== myId) {
          markChannelUnread(event.message.dmChannelId);
        }
      }
      break;
    }

    case 'dm_message_updated':
      if (!isHome) {
        normalizeMessageAssets(event.message as any, origin);
        if ((event.message as any).embeds) {
          for (const embed of (event.message as any).embeds) {
            if (embed.image && !embed.image.startsWith('http')) {
              embed.image = resolveAssetUrl(embed.image, origin) ?? embed.image;
            }
          }
        }
      }
      updateMessage(event.message as any);
      break;

    case 'dm_message_deleted':
      removeMessage(event.messageId, event.dmChannelId);
      break;

    case 'embeds_resolved': {
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
      break;
    }

    case 'dm_embeds_resolved': {
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
      break;
    }

    case 'dm_typing': {
      let dmTypingUsername = event.username as string;
      if (!isHome && dmTypingUsername && !dmTypingUsername.includes('@')) {
        try { dmTypingUsername = `${dmTypingUsername}@${new URL(origin).host}`; } catch {}
      }
      setTyping(event.dmChannelId, event.userId, dmTypingUsername);
      break;
    }

    // ─── Reactions (all origins) ────────────────────────────────────────────

    case 'reaction_added':
      onReactionAdded(event.messageId, event.reaction);
      break;

    case 'reaction_removed':
      onReactionRemoved(event.messageId, event.userId, event.emoji);
      break;

    // ─── Social events (all origins — federation) ──────────────────────────

    case 'friend_request_received': {
      if (!isHome && event.request.user) normalizeUserAssets(event.request.user, origin);
      const { addIncomingRequest } = useSocialStore.getState();
      addIncomingRequest(event.request, origin);
      break;
    }

    case 'friend_request_accepted': {
      if (!isHome) normalizeUserAssets(event.friend, origin);
      const { addFriendFromAccepted } = useSocialStore.getState();
      addFriendFromAccepted(event.friend, event.requestId, origin);
      break;
    }

    case 'friend_removed': {
      const { removeFriendLocally } = useSocialStore.getState();
      removeFriendLocally(event.userId, origin);
      break;
    }

    case 'friend_request_cancelled': {
      const { removeRequestById } = useSocialStore.getState();
      removeRequestById(event.requestId, origin);
      import('../stores/discoverStore').then(({ useDiscoverStore }) => {
        useDiscoverStore.getState().updateRelationship(event.userId, origin, 'none');
      });
      break;
    }

    case 'friend_request_declined': {
      const { removeRequestById } = useSocialStore.getState();
      removeRequestById(event.requestId, origin);
      import('../stores/discoverStore').then(({ useDiscoverStore }) => {
        useDiscoverStore.getState().updateRelationship(event.userId, origin, 'none');
      });
      break;
    }

    // ─── Channel ack (all origins) ──────────────────────────────────────────

    case 'channel_ack': {
      const { onChannelAck } = useChatStore.getState();
      onChannelAck(event.channelId, event.messageId);
      break;
    }

    case 'mark_unread': {
      const { onMarkUnread } = useChatStore.getState();
      onMarkUnread(event.channelId, event.messageId);
      break;
    }

    // ─── DM call events (all origins) ──────────────────────────────────────

    case 'dm_call_incoming': {
      const { setIncomingCall } = useVoiceStore.getState();
      setIncomingCall({
        dmChannelId: event.dmChannelId,
        callerId: event.callerId,
        callerName: event.callerName,
      });
      break;
    }

    case 'dm_call_accepted': {
      const { setIncomingCall, setOutgoingCall, setActiveDmCall } = useVoiceStore.getState();
      setIncomingCall(null);
      setOutgoingCall(null);
      setActiveDmCall({ dmChannelId: event.dmChannelId });
      break;
    }

    case 'dm_call_rejected': {
      const { setIncomingCall, setOutgoingCall, setActiveDmCall } = useVoiceStore.getState();
      setIncomingCall(null);
      setOutgoingCall(null);
      setActiveDmCall(null);
      break;
    }

    case 'dm_call_ended': {
      const { setIncomingCall, setOutgoingCall, setActiveDmCall } = useVoiceStore.getState();
      setIncomingCall(null);
      setOutgoingCall(null);
      setActiveDmCall(null);
      break;
    }

    // ─── DM channel events (home-only) ──────────────────────────────────────

    case 'dm_channel_created':
      if (!isHome) {
        for (const m of event.dmChannel.members) {
          normalizeUserAssets(m, origin);
        }
      }
      addDmChannel(event.dmChannel, origin);
      break;

    case 'dm_channel_closed':
      removeDmChannel(event.dmChannelId);
      break;

    case 'dm_member_added': {
      if (!isHome) normalizeUserAssets(event.user, origin);
      const { addDmMember } = useSpaceStore.getState();
      addDmMember(event.dmChannelId, event.user);
      break;
    }

    case 'dm_member_removed': {
      const { removeDmMember } = useSpaceStore.getState();
      removeDmMember(event.dmChannelId, event.userId);
      break;
    }

    // ─── Channel/space events (all origins) ─────────────────────────────────

    case 'channel_created': {
      const { currentSpaceId: curSpaceId, channels: curChannels, setChannels, channelToSpaceMap, channelPermissions, channelOriginMap, voiceChannelIds } = useSpaceStore.getState();
      if (event.spaceId === curSpaceId) {
        if (!curChannels.find(c => c.id === event.channel.id)) {
          setChannels([...curChannels, event.channel].sort((a, b) => a.position - b.position));
        }
      }
      channelToSpaceMap.set(event.channel.id, event.spaceId);
      channelOriginMap.set(event.channel.id, origin);
      if (event.channel.type === 'voice') {
        voiceChannelIds.add(event.channel.id);
      }
      if (event.channel.myPermissions) {
        channelPermissions.set(event.channel.id, event.channel.myPermissions);
      }
      break;
    }

    case 'channel_updated': {
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
      break;
    }

    case 'channel_deleted': {
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
        if (vs.voiceUsers.has(event.channelId)) {
          const newVoiceUsers = new Map(vs.voiceUsers);
          newVoiceUsers.delete(event.channelId);
          useVoiceStore.setState({ voiceUsers: newVoiceUsers });
        }
      }
      break;
    }

    case 'space_updated': {
      if (!isHome && event.space.icon) {
        event.space.icon = resolveAssetUrl(event.space.icon, origin) ?? event.space.icon;
      }
      if (!isHome && event.space.banner) {
        event.space.banner = resolveAssetUrl(event.space.banner, origin) ?? event.space.banner;
      }
      const { spaces: currentSpaces, setSpaces } = useSpaceStore.getState();
      setSpaces(currentSpaces.map(s => s.id === event.space.id ? { ...s, ...event.space } : s));
      break;
    }

    // ─── Category events (all origins) ────────────────────────────────────

    case 'category_created': {
      const { currentSpaceId: catSpaceId, categories: curCategories, setCategories: setCats, categoryOriginMap: catOriginMap } = useSpaceStore.getState();
      catOriginMap.set(event.category.id, origin);
      if (event.spaceId === catSpaceId) {
        if (!curCategories.some(c => c.id === event.category.id)) {
          setCats([...curCategories, event.category].sort((a, b) => a.position - b.position));
        }
      }
      break;
    }

    case 'category_updated': {
      const { currentSpaceId: catSpaceId2, categories: curCategories2, setCategories: setCats2 } = useSpaceStore.getState();
      if (event.spaceId === catSpaceId2) {
        setCats2(curCategories2.map(c => c.id === event.category.id ? event.category : c).sort((a, b) => a.position - b.position));
      }
      break;
    }

    case 'category_deleted': {
      const { currentSpaceId: catSpaceId3, categories: curCategories3, setCategories: setCats3, channels: curChsForCat, setChannels: setChsForCat, categoryOriginMap: catOriginMap3 } = useSpaceStore.getState();
      catOriginMap3.delete(event.categoryId);
      if (event.spaceId === catSpaceId3) {
        setCats3(curCategories3.filter(c => c.id !== event.categoryId));
        // Null out categoryId on affected channels (server already did this, but sync local state)
        setChsForCat(curChsForCat.map(ch => ch.categoryId === event.categoryId ? { ...ch, categoryId: null } : ch));
      }
      break;
    }

    case 'channel_layout_updated': {
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
      break;
    }

    case 'space_layout_updated': {
      // LWW: only accept if incoming timestamp >= current
      const incomingTs = event.updatedAt ?? 0;
      const currentTs = useSpaceStore.getState()._layoutUpdatedAt;
      if (incomingTs >= currentTs) {
        useSpaceStore.getState().setSpaceLayout(event.layout);
        useSpaceStore.setState({ folders: event.folders, _layoutUpdatedAt: incomingTs });
      }
      break;
    }

    // ─── Join request events (home-only) ────────────────────────────────

    case 'join_request_received': {
      if (!isHome) break;
      console.log('[WebSocket] Join request received from', event.request.user?.username ?? event.request.userId);
      break;
    }

    case 'join_request_accepted': {
      if (!isHome) break;
      // Add the space to our space list
      const { addSpaceFromReady } = useSpaceStore.getState();
      addSpaceFromReady(origin, event.space);
      console.log('[WebSocket] Join request accepted for space', event.space.name);
      break;
    }

    case 'join_request_declined': {
      if (!isHome) break;
      console.log('[WebSocket] Join request declined for space', event.request.spaceId);
      break;
    }

    case 'pong':
      break;

    case 'error':
      console.error(`WebSocket error (${origin || 'home'}):`, event.message);
      break;
  }
}

// ─── Connection management ────────────────────────────────────────────────────

function getOrCreateConnection(origin: string, token: string): ConnectionState {
  let conn = connections.get(origin);
  if (!conn) {
    conn = {
      ws: null,
      heartbeatWorker: null,
      reconnectAttempts: 0,
      reconnectTimer: undefined,
      token,
    };
    connections.set(origin, conn);
  } else {
    conn.token = token;
  }
  return conn;
}

function connectToOrigin(origin: string, token: string): void {
  const conn = getOrCreateConnection(origin, token);

  if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsUrl = buildWsUrl(origin);
  const ws = new WebSocket(wsUrl);
  conn.ws = ws;

  ws.onopen = () => {
    conn.reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'auth', token: conn.token }));
    startHeartbeat(conn);
  };

  ws.onmessage = (e) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(e.data as string) as ServerEvent;
    } catch {
      console.error(`Failed to parse WebSocket message (${origin || 'home'})`);
      return;
    }
    try {
      handleEvent(origin, event);
    } catch (err) {
      console.error(`Error handling WS event "${event.type}" (${origin || 'home'}):`, err);
    }
  };

  ws.onclose = () => {
    conn.ws = null;
    stopHeartbeat(conn);
    // Mark remote instance as disconnected in instanceStore
    if (origin !== HOME_ORIGIN) {
      import('../stores/instanceStore').then(({ useInstanceStore }) => {
        useInstanceStore.getState().setInstanceStatus(origin, 'disconnected', 'Connection lost — reconnecting');
      });
    }
    // Only reconnect if the connection is still registered (not explicitly disconnected)
    if (connections.has(origin) && conn.token) {
      const delay = Math.min(1000 * Math.pow(2, conn.reconnectAttempts), 30000);
      conn.reconnectAttempts++;
      conn.reconnectTimer = setTimeout(() => connectToOrigin(origin, conn.token), delay);
    }
  };

  ws.onerror = () => {
    ws.close();
  };
}

function disconnectFromOrigin(origin: string): void {
  const conn = connections.get(origin);
  if (!conn) return;

  // Clear token to prevent reconnect
  conn.token = '';

  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = undefined;
  }
  stopHeartbeat(conn);
  if (conn.ws) {
    conn.ws.close();
    conn.ws = null;
  }
  connections.delete(origin);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Connect to a remote instance's WebSocket. Called by instanceStore. */
export function connectInstance(origin: string, token: string): void {
  connectToOrigin(origin, token);
}

/** Disconnect from a remote instance's WebSocket. Called by instanceStore. */
export function disconnectInstance(origin: string): void {
  disconnectFromOrigin(origin);
}

/** Disconnect all remote (non-home) WebSocket connections. Called on logout. */
export function disconnectAllRemote(): void {
  for (const origin of [...connections.keys()]) {
    if (origin !== HOME_ORIGIN) {
      disconnectFromOrigin(origin);
    }
  }
}

/** Read-only home WS connection status — safe to call from any component without managing lifecycle. */
export function getHomeWsConnected(): boolean {
  const conn = connections.get(HOME_ORIGIN);
  return !!conn?.ws && conn.ws.readyState === WebSocket.OPEN;
}

/** Send an event over the WebSocket. Can be used outside of React components. */
export function wsSend(event: ClientEvent, origin: string = HOME_ORIGIN): void {
  const conn = connections.get(origin);
  if (conn?.ws && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(event));
  }
}

/**
 * Hook to initialize the home WebSocket connection. Should only be called ONCE
 * from the top-level layout component (AppLayout). Other components should
 * use the exported `wsSend` function directly.
 *
 * Remote instance connections are managed by instanceStore via
 * connectInstance/disconnectInstance — not by this hook.
 */
export function useWebSocket() {
  const token = useAuthStore((s) => s.token);
  const prevToken = useRef(token);
  const [isConnected, setIsConnected] = React.useState(false);

  useEffect(() => {
    if (token && (!homeInitialized || token !== prevToken.current)) {
      homeInitialized = true;
      connectToOrigin(HOME_ORIGIN, token);
    } else if (!token && homeInitialized) {
      homeInitialized = false;
      disconnectFromOrigin(HOME_ORIGIN);
    }
    prevToken.current = token;
  }, [token]);

  useEffect(() => {
    const checkStatus = setInterval(() => {
      const conn = connections.get(HOME_ORIGIN);
      setIsConnected(!!conn?.ws && conn.ws.readyState === WebSocket.OPEN);
    }, 500);
    return () => {
      clearInterval(checkStatus);
      homeInitialized = false;
      disconnectFromOrigin(HOME_ORIGIN);
    };
  }, []);

  return { send: wsSend, isConnected };
}
