import React, { useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useChatStore } from '../stores/chatStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useSocialStore } from '../stores/socialStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { ServerEvent, ClientEvent, ActiveCallInfo } from '@backspace/shared';
import { resolveAssetUrl, normalizeUserAssets, normalizeMessageAssets } from '../utils/assetUrls';

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
  const { populateFromReady, loadServerDetail, currentServerId, updateMemberPresence, addMember, removeMember, addDmChannel, removeDmChannel } = useServerStore.getState();
  const { addMessage, addRealtimeMessage, updateMessage, removeMessage, setTyping, onReactionAdded, onReactionRemoved } = useChatStore.getState();
  const { addVoiceUser, removeVoiceUser, clearAllVoiceUsers, clearVoiceUsersForOrigin, setVoiceUsers, setVoiceUserStatus, clearVoiceUserStatus } = useVoiceStore.getState();

  switch (event.type) {
    case 'ready':
      if (isHome) {
        setUser(event.user);
        useSettingsStore.getState().setIsAdmin(event.user.isAdmin ?? false);
        useSettingsStore.getState().fetchStreamingLimits();
      }

      // Normalize asset URLs for remote origins before dispatching to stores
      if (!isHome) {
        for (const server of event.servers) {
          if (server.icon) server.icon = resolveAssetUrl(server.icon, origin) ?? server.icon;
          if ((server as any).members) {
            for (const member of (server as any).members) {
              if (member.user) normalizeUserAssets(member.user, origin);
            }
          }
        }
      }

      populateFromReady(origin, event.servers, event.folders, event.dmChannels);

      // Mark remote instance as connected in instanceStore
      if (!isHome) {
        import('../stores/instanceStore').then(({ useInstanceStore }) => {
          useInstanceStore.getState().setInstanceStatus(origin, 'connected');
        });
      }

      if (isHome && currentServerId) {
        loadServerDetail(currentServerId);
      }

      // Only force-reload the current channel on reconnect; other channels keep their cache
      if (isHome) {
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

      // Clear voice state for the reconnecting origin before repopulating
      if (isHome) {
        clearAllVoiceUsers();
      } else {
        clearVoiceUsersForOrigin(origin);
      }
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

      // Re-register in voice channel if we're still connected to LiveKit (home only)
      if (isHome) {
        const { currentVoiceChannelId, isMuted: curMuted, isDeafened: curDeafened, isCameraOn: curCamera, isScreenSharing: curScreen } = useVoiceStore.getState();
        if (currentVoiceChannelId) {
          console.log('[WebSocket] Re-syncing voice status on reconnect:', { currentVoiceChannelId, curMuted, curDeafened, curCamera, curScreen });
          wsSend({ type: 'voice_join', channelId: currentVoiceChannelId });
          wsSend({ type: 'voice_status', isMuted: curMuted, isDeafened: curDeafened, isCameraOn: curCamera, isScreenSharing: curScreen });
        }
      }

      // Restore DM call state from server (home only)
      if (isHome) {
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
      break;

    case 'message_created':
      if (!isHome) normalizeMessageAssets(event.message, origin);
      addRealtimeMessage(event.message.channelId, event.message);
      {
        const { currentChannelId, markChannelUnread } = useChatStore.getState();
        if (event.message.channelId !== currentChannelId) {
          markChannelUnread(event.message.channelId);
        }
      }
      break;

    case 'message_updated':
      if (!isHome) normalizeMessageAssets(event.message, origin);
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
      if (isHome) {
        useSocialStore.getState().updateFriendPresence(event.userId, event.status);
      }
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
      if (!isHome) normalizeUserAssets(event.member.user, origin);
      addMember(event.member);
      break;

    case 'member_left':
      removeMember(event.userId);
      break;

    // ─── DM events (home-only) ──────────────────────────────────────────────

    case 'dm_message_created': {
      if (!isHome) break;
      addRealtimeMessage(event.message.dmChannelId, event.message as any);
      const { dmChannels: currentDmChannels, setDmChannels: setDms, addDmChannel: addDmCh } = useServerStore.getState();
      const knownDm = currentDmChannels.find(dm => dm.id === event.message.dmChannelId);
      if (!knownDm) {
        addDmCh({
          id: event.message.dmChannelId,
          createdAt: event.message.createdAt,
          members: event.message.user ? [event.message.user] : [],
          lastMessage: event.message,
        });
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
        if (event.message.dmChannelId !== currentChannelId) {
          markChannelUnread(event.message.dmChannelId);
        }
      }
      break;
    }

    case 'dm_message_updated':
      if (!isHome) break;
      updateMessage(event.message as any);
      break;

    case 'dm_message_deleted':
      if (!isHome) break;
      removeMessage(event.messageId, event.dmChannelId);
      break;

    case 'dm_typing':
      if (!isHome) break;
      setTyping(event.dmChannelId, event.userId, event.username);
      break;

    // ─── Reactions (all origins) ────────────────────────────────────────────

    case 'reaction_added':
      onReactionAdded(event.messageId, event.reaction);
      break;

    case 'reaction_removed':
      onReactionRemoved(event.messageId, event.userId, event.emoji);
      break;

    // ─── Social events (home-only) ──────────────────────────────────────────

    case 'friend_request_received': {
      if (!isHome) break;
      const { addIncomingRequest } = useSocialStore.getState();
      addIncomingRequest(event.request);
      break;
    }

    case 'friend_request_accepted': {
      if (!isHome) break;
      const { addFriendFromAccepted } = useSocialStore.getState();
      addFriendFromAccepted(event.friend, event.requestId);
      break;
    }

    case 'friend_removed': {
      if (!isHome) break;
      const { removeFriendLocally } = useSocialStore.getState();
      removeFriendLocally(event.userId);
      break;
    }

    // ─── Channel ack (all origins) ──────────────────────────────────────────

    case 'channel_ack': {
      const { onChannelAck } = useChatStore.getState();
      onChannelAck(event.channelId, event.messageId);
      break;
    }

    // ─── DM call events (home-only) ─────────────────────────────────────────

    case 'dm_call_incoming': {
      if (!isHome) break;
      const { setIncomingCall } = useVoiceStore.getState();
      setIncomingCall({
        dmChannelId: event.dmChannelId,
        callerId: event.callerId,
        callerName: event.callerName,
      });
      break;
    }

    case 'dm_call_accepted': {
      if (!isHome) break;
      const { setIncomingCall, setOutgoingCall, setActiveDmCall } = useVoiceStore.getState();
      setIncomingCall(null);
      setOutgoingCall(null);
      setActiveDmCall({ dmChannelId: event.dmChannelId });
      break;
    }

    case 'dm_call_rejected': {
      if (!isHome) break;
      const { setIncomingCall, setOutgoingCall, setActiveDmCall } = useVoiceStore.getState();
      setIncomingCall(null);
      setOutgoingCall(null);
      setActiveDmCall(null);
      break;
    }

    case 'dm_call_ended': {
      if (!isHome) break;
      const { setIncomingCall, setOutgoingCall, setActiveDmCall } = useVoiceStore.getState();
      setIncomingCall(null);
      setOutgoingCall(null);
      setActiveDmCall(null);
      break;
    }

    // ─── DM channel events (home-only) ──────────────────────────────────────

    case 'dm_channel_created':
      if (!isHome) break;
      addDmChannel(event.dmChannel);
      break;

    case 'dm_channel_closed':
      if (!isHome) break;
      removeDmChannel(event.dmChannelId);
      break;

    case 'dm_member_added': {
      if (!isHome) break;
      const { addDmMember } = useServerStore.getState();
      addDmMember(event.dmChannelId, event.user);
      break;
    }

    case 'dm_member_removed': {
      if (!isHome) break;
      const { removeDmMember } = useServerStore.getState();
      removeDmMember(event.dmChannelId, event.userId);
      break;
    }

    // ─── Channel/server events (all origins) ────────────────────────────────

    case 'channel_created': {
      const { currentServerId: curServerId, channels: curChannels, setChannels, channelToServerMap, channelPermissions, channelOriginMap } = useServerStore.getState();
      if (event.serverId === curServerId) {
        if (!curChannels.find(c => c.id === event.channel.id)) {
          setChannels([...curChannels, event.channel].sort((a, b) => a.position - b.position));
        }
      }
      channelToServerMap.set(event.channel.id, event.serverId);
      channelOriginMap.set(event.channel.id, origin);
      if (event.channel.myPermissions) {
        channelPermissions.set(event.channel.id, event.channel.myPermissions);
      }
      break;
    }

    case 'channel_updated': {
      const { currentServerId: curServerId2, channels: curChannels2, setChannels: setChannels2, channelPermissions: chPermsMap2 } = useServerStore.getState();
      if (event.serverId === curServerId2) {
        const exists = curChannels2.some(c => c.id === event.channel.id);
        if (exists) {
          setChannels2(curChannels2.map(c => c.id === event.channel.id ? event.channel : c).sort((a, b) => a.position - b.position));
        } else {
          setChannels2([...curChannels2, event.channel].sort((a, b) => a.position - b.position));
          const { channelToServerMap: ctsMmap, channelOriginMap: coMap } = useServerStore.getState();
          ctsMmap.set(event.channel.id, event.serverId);
          coMap.set(event.channel.id, origin);
        }
      }
      if (event.channel.myPermissions) {
        chPermsMap2.set(event.channel.id, event.channel.myPermissions);
      }
      break;
    }

    case 'channel_deleted': {
      const { currentServerId: curServerId3, channels: curChannels3, setChannels: setChannels3, channelPermissions: chPermsMap3, channelToServerMap: ctsMap3, channelOriginMap: coMap3 } = useServerStore.getState();
      if (event.serverId === curServerId3) {
        setChannels3(curChannels3.filter(c => c.id !== event.channelId));
      }
      chPermsMap3.delete(event.channelId);
      ctsMap3.delete(event.channelId);
      coMap3.delete(event.channelId);
      {
        const { currentChannelId } = useChatStore.getState();
        if (currentChannelId === event.channelId) {
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
      if (!isHome && event.server.icon) {
        event.server.icon = resolveAssetUrl(event.server.icon, origin) ?? event.server.icon;
      }
      const { servers: currentServers, setServers } = useServerStore.getState();
      setServers(currentServers.map(s => s.id === event.server.id ? { ...s, ...event.server } : s));
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
    try {
      const event = JSON.parse(e.data as string) as ServerEvent;
      handleEvent(origin, event);
    } catch {
      console.error(`Failed to parse WebSocket message (${origin || 'home'})`);
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
