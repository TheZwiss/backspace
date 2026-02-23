import React, { useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useChatStore } from '../stores/chatStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useSocialStore } from '../stores/socialStore';
import type { ServerEvent, ClientEvent } from '@opencord/shared';

let globalWs: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
let currentToken: string | null = null;
let isInitialized = false;

function handleEvent(event: ServerEvent): void {
  const { setUser } = useAuthStore.getState();
  const { populateFromReady, loadServerDetail, currentServerId, updateMemberPresence, addMember, removeMember, addDmChannel, removeDmChannel } = useServerStore.getState();
  const { addMessage, addRealtimeMessage, updateMessage, removeMessage, setTyping, onReactionAdded, onReactionRemoved } = useChatStore.getState();
  const { addVoiceUser, removeVoiceUser, clearAllVoiceUsers, setVoiceUsers, setVoiceUserStatus, clearVoiceUserStatus } = useVoiceStore.getState();

  switch (event.type) {
    case 'ready':
      setUser(event.user);
      populateFromReady(event.servers, event.folders, event.dmChannels);
      if (currentServerId) {
        loadServerDetail(currentServerId);
      }
      // Only force-reload the current channel on reconnect; other channels keep their cache
      {
        const { loadMessages: reloadMessages, currentChannelId, setReadStates } = useChatStore.getState();
        if (currentChannelId) {
          reloadMessages(currentChannelId, true);
        }
        // Initialize unread tracking from ready payload
        const { channelLastMessageIds } = useServerStore.getState();
        if (event.readStates) {
          setReadStates(event.readStates, channelLastMessageIds);
        }
      }
      // Clear stale voice state, then populate from server truth
      clearAllVoiceUsers();
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
      // Re-register in voice channel if we're still connected to LiveKit
      // (WebSocket reconnect causes server to drop our voice tracking)
      {
        const { currentVoiceChannelId, isMuted: curMuted, isDeafened: curDeafened, isCameraOn: curCamera, isScreenSharing: curScreen } = useVoiceStore.getState();
        if (currentVoiceChannelId) {
          console.log('[WebSocket] Re-syncing voice status on reconnect:', { currentVoiceChannelId, curMuted, curDeafened, curCamera, curScreen });
          wsSend({ type: 'voice_join', channelId: currentVoiceChannelId });
          wsSend({ type: 'voice_status', isMuted: curMuted, isDeafened: curDeafened, isCameraOn: curCamera, isScreenSharing: curScreen });
        }
      }
      break;

    case 'message_created':
      addRealtimeMessage(event.message.channelId, event.message);
      {
        const { currentChannelId, markChannelUnread } = useChatStore.getState();
        if (event.message.channelId !== currentChannelId) {
          markChannelUnread(event.message.channelId);
        }
      }
      break;

    case 'message_updated':
      updateMessage(event.message);
      break;

    case 'message_deleted':
      removeMessage(event.messageId, event.channelId);
      break;

    case 'typing':
      setTyping(event.channelId, event.userId, event.username);
      break;

    case 'presence_update':
      updateMemberPresence(event.userId, event.status);
      useSocialStore.getState().updateFriendPresence(event.userId, event.status);
      break;

    case 'voice_state_update':
      if (event.action === 'join') {
        addVoiceUser(event.channelId, event.userId);
      } else {
        removeVoiceUser(event.channelId, event.userId);
      }
      break;

    case 'voice_status_update':
      setVoiceUserStatus(event.userId, event.isMuted, event.isDeafened, event.isCameraOn, event.isScreenSharing);
      break;

    case 'member_joined':
      addMember(event.member);
      break;

    case 'member_left':
      removeMember(event.userId);
      break;

    case 'dm_message_created': {
      addRealtimeMessage(event.message.dmChannelId, event.message as any);
      // If DM channel is unknown (first-ever message safety net), add a minimal one
      const { dmChannels: currentDmChannels, setDmChannels: setDms, addDmChannel: addDmCh } = useServerStore.getState();
      const knownDm = currentDmChannels.find(dm => dm.id === event.message.dmChannelId);
      if (!knownDm) {
        // Construct a minimal DmChannel from the message so the sidebar shows it
        addDmCh({
          id: event.message.dmChannelId,
          createdAt: event.message.createdAt,
          members: event.message.user ? [event.message.user] : [],
          lastMessage: event.message,
        });
      } else {
        // Update lastMessage on the DM channel so the sidebar sorts correctly
        const updatedDms = currentDmChannels.map(dm =>
          dm.id === event.message.dmChannelId
            ? { ...dm, lastMessage: event.message }
            : dm
        );
        // Re-sort by most recent message
        updatedDms.sort((a, b) => {
          const aTime = a.lastMessage?.createdAt ?? a.createdAt;
          const bTime = b.lastMessage?.createdAt ?? b.createdAt;
          return bTime - aTime;
        });
        setDms(updatedDms);
      }
      // Mark DM as unread if not currently viewing it
      {
        const { currentChannelId, markChannelUnread } = useChatStore.getState();
        if (event.message.dmChannelId !== currentChannelId) {
          markChannelUnread(event.message.dmChannelId);
        }
      }
      break;
    }

    case 'dm_message_updated':
      updateMessage(event.message as any);
      break;

    case 'dm_message_deleted':
      removeMessage(event.messageId, event.dmChannelId);
      break;

    case 'dm_typing':
      setTyping(event.dmChannelId, event.userId, event.username);
      break;

    case 'reaction_added':
      onReactionAdded(event.messageId, event.reaction);
      break;

    case 'reaction_removed':
      onReactionRemoved(event.messageId, event.userId, event.emoji);
      break;

    case 'friend_request_received': {
      const { addIncomingRequest } = useSocialStore.getState();
      addIncomingRequest(event.request);
      break;
    }

    case 'friend_request_accepted': {
      const { addFriendFromAccepted } = useSocialStore.getState();
      addFriendFromAccepted(event.friend, event.requestId);
      break;
    }

    case 'channel_ack': {
      const { onChannelAck } = useChatStore.getState();
      onChannelAck(event.channelId, event.messageId);
      break;
    }

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

    case 'dm_channel_created':
      addDmChannel(event.dmChannel);
      break;

    case 'dm_channel_closed':
      removeDmChannel(event.dmChannelId);
      break;

    case 'friend_removed': {
      const { removeFriendLocally } = useSocialStore.getState();
      removeFriendLocally(event.userId);
      break;
    }

    case 'channel_created': {
      const { currentServerId: curServerId, channels: curChannels, setChannels } = useServerStore.getState();
      if (event.serverId === curServerId) {
        // Deduplicate: only add if not already present
        if (!curChannels.find(c => c.id === event.channel.id)) {
          setChannels([...curChannels, event.channel].sort((a, b) => a.position - b.position));
        }
      }
      break;
    }

    case 'channel_updated': {
      const { currentServerId: curServerId2, channels: curChannels2, setChannels: setChannels2 } = useServerStore.getState();
      if (event.serverId === curServerId2) {
        setChannels2(curChannels2.map(c => c.id === event.channel.id ? event.channel : c).sort((a, b) => a.position - b.position));
      }
      break;
    }

    case 'channel_deleted': {
      const { currentServerId: curServerId3, channels: curChannels3, setChannels: setChannels3 } = useServerStore.getState();
      if (event.serverId === curServerId3) {
        setChannels3(curChannels3.filter(c => c.id !== event.channelId));
      }
      // If the user is currently viewing this channel, navigate away
      {
        const { currentChannelId } = useChatStore.getState();
        if (currentChannelId === event.channelId) {
          // Find the first remaining text channel to navigate to
          const { channels: remainingChannels } = useServerStore.getState();
          const firstText = remainingChannels.find(c => c.type === 'text');
          if (firstText) {
            useChatStore.getState().setCurrentChannel(firstText.id);
          } else {
            useChatStore.getState().setCurrentChannel(null);
          }
        }
      }
      break;
    }

    case 'server_updated': {
      const { servers: currentServers, setServers } = useServerStore.getState();
      setServers(currentServers.map(s => s.id === event.server.id ? { ...s, ...event.server } : s));
      break;
    }

    case 'pong':
      // Heartbeat response — no action needed
      break;

    case 'error':
      console.error('WebSocket error:', event.message);
      break;
  }
}

function connect(): void {
  if (!currentToken) return;
  if (globalWs && (globalWs.readyState === WebSocket.OPEN || globalWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  const ws = new WebSocket(wsUrl);
  globalWs = ws;

  ws.onopen = () => {
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'auth', token: currentToken }));

    // Start heartbeat to keep connection alive through proxies/NATs
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30_000);
  };

  ws.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data as string) as ServerEvent;
      handleEvent(event);
    } catch {
      console.error('Failed to parse WebSocket message');
    }
  };

  ws.onclose = () => {
    globalWs = null;
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }
    if (currentToken) {
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
      reconnectAttempts++;
      reconnectTimer = setTimeout(connect, delay);
    }
  };

  ws.onerror = () => {
    ws.close();
  };
}

function disconnect(): void {
  currentToken = null;
  isInitialized = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = undefined;
  }
  if (globalWs) {
    globalWs.close();
    globalWs = null;
  }
}

/** Send an event over the WebSocket. Can be used outside of React components. */
export function wsSend(event: ClientEvent): void {
  if (globalWs && globalWs.readyState === WebSocket.OPEN) {
    globalWs.send(JSON.stringify(event));
  }
}

/**
 * Hook to initialize the WebSocket connection. Should only be called ONCE
 * from the top-level layout component (AppLayout). Other components should
 * use the exported `wsSend` function directly.
 */
export function useWebSocket() {
  const token = useAuthStore((s) => s.token);
  const prevToken = useRef(token);
  const [isConnected, setIsConnected] = React.useState(false);

  useEffect(() => {
    if (token && (!isInitialized || token !== prevToken.current)) {
      currentToken = token;
      isInitialized = true;
      connect();
    } else if (!token && isInitialized) {
      disconnect();
    }
    prevToken.current = token;
  }, [token]);

  useEffect(() => {
    const checkStatus = setInterval(() => {
      setIsConnected(!!globalWs && globalWs.readyState === WebSocket.OPEN);
    }, 500);
    return () => {
      clearInterval(checkStatus);
      disconnect();
    };
  }, []);

  return { send: wsSend, isConnected };
}
