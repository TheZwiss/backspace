import React, { useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useSpaceStore, getChannelOrigin, getMyUserIdForOrigin, setMyUserIdForOrigin, resolveDmChannelId } from '../stores/spaceStore';
import { useChatStore } from '../stores/chatStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useSocialStore } from '../stores/socialStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { ServerEvent, ClientEvent, ActiveCallInfo, Activity, User } from '@backspace/shared';
import { resolveAssetUrl, normalizeUserAssets, normalizeMessageAssets } from '../utils/assetUrls';
import { broadcastVoiceStatus, broadcastDeafenViaLiveKit } from '../utils/voice';
import { applySpaceVoiceState } from '../utils/voiceStateSync';
import { sortDmChannels } from '../utils/dmSorting';
import { registerSelfId } from '../utils/identity';
import { getActiveRoom } from './useLiveKit';
import { useUIStore } from '../stores/uiStore';
import { useActivityStore } from '../stores/activityStore';
import { useDiscoverStore } from '../stores/discoverStore';
import { useFederationStore } from '../stores/federationStore';

// ─── Rejected peer origins (for unreachable member indicators) ───────────────
const rejectedPeerOrigins = new Set<string>();

export function getRejectedPeerOrigins(): Set<string> {
  return rejectedPeerOrigins;
}

const awaitingApprovalPeerOrigins = new Set<string>();

export function getAwaitingApprovalPeerOrigins(): Set<string> {
  return awaitingApprovalPeerOrigins;
}

// Active peer origins — allowlist for processing DM events from remote instances.
// Only DMs from peered origins (or the home instance) are processed.
const activePeerOrigins = new Set<string>();

export function getActivePeerOrigins(): Set<string> {
  return activePeerOrigins;
}

// ─── Federation change listeners (for real-time panel updates) ───────────────
const federationChangeListeners = new Set<() => void>();

export function onFederationPeersChanged(cb: () => void): () => void {
  federationChangeListeners.add(cb);
  return () => { federationChangeListeners.delete(cb); };
}

function notifyFederationChangeListeners(): void {
  for (const cb of federationChangeListeners) cb();
}

const federationPeerResetDetectedListeners = new Set<(origin: string) => void>();

export function onFederationPeerResetDetected(cb: (origin: string) => void): () => void {
  federationPeerResetDetectedListeners.add(cb);
  return () => { federationPeerResetDetectedListeners.delete(cb); };
}

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

// ─── Call relay helpers ───────────────────────────────────────────────────────

import { buildCallUndeliverableToast } from '../utils/callUndeliverableToast';

export { buildCallUndeliverableToast };

// ─── Event handling ───────────────────────────────────────────────────────────

const HOME_ORIGIN = '';

/**
 * Tear down local state for a DM call that ended, was rejected, or became
 * terminally undeliverable. Clears the call UI/federation state, and tears
 * down the LiveKit session **only when the active voice connection still
 * belongs to the DM call**.
 *
 * The guard is load-bearing: `disconnectFn()` tears down whatever LiveKit room
 * is currently active, regardless of which channel it is. Once the user has
 * joined a *space* voice channel, `currentVoiceChannelId` is set and the active
 * room is the space channel — NOT the DM call (the two are mutually exclusive;
 * `setCurrentVoiceChannel` clears `activeDmCall`). A stale `dm_call_ended` echo
 * must never disconnect that space connection.
 *
 * This is exactly what happens to the **last** participant to leave a DM call
 * for a space channel: their `voice_join` empties the server-side DM room, the
 * server broadcasts `dm_call_ended` back to every DM member (including them),
 * and an unguarded `disconnectFn()` would tear down the space room they just
 * connected to — stranding the UI on "Connecting…" until a manual rejoin.
 */
export function teardownDmCall(): void {
  const voice = useVoiceStore.getState();
  voice.setIncomingCall(null);
  voice.setOutgoingCall(null);
  voice.setActiveDmCall(null);
  voice.clearFederatedCallData();
  // Never tear down a space voice connection in response to a DM-call signal.
  if (voice.disconnectFn && !voice.currentVoiceChannelId) voice.disconnectFn();
}

function handleEvent(origin: string, event: ServerEvent): void {
  const isHome = origin === HOME_ORIGIN;
  const { setUser } = useAuthStore.getState();
  const { populateFromReady, loadSpaceDetail, currentSpaceId, updateMemberPresence, addMember, removeMember, addDmChannel, removeDmChannel, upsertUserView } = useSpaceStore.getState();
  const { addMessage, addRealtimeMessage, updateMessage, removeMessage, setTyping, clearTyping, onReactionAdded, onReactionRemoved } = useChatStore.getState();
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
      // Initialize activity data from ready payload
      if (event.userActivities) {
        useActivityStore.getState().initActivities(event.userActivities);
      }
      if (event.user.showActivity !== undefined) {
        useActivityStore.setState({ showActivity: event.user.showActivity });
      }

      // Re-push local Electron activities after reconnect (sleep/wake, network blip, etc.)
      // The process scanner keeps running but onActivityDetected only fires on change,
      // so if the same app was active before and after sleep, nothing would re-push.
      if (isHome && window.backspace?.getCurrentActivity) {
        window.backspace.getCurrentActivity().then((activity: unknown) => {
          if (activity) {
            useActivityStore.getState().pushActivities([activity as Activity]);
          }
        }).catch(() => {});
      }

      // Re-push current activities to newly connected instances so their
      // in-memory activity store is populated immediately (covers the case
      // where a user starts a game, then a remote instance connects later).
      {
        const { myActivities, showActivity } = useActivityStore.getState();
        if (showActivity && myActivities && myActivities.length > 0) {
          wsSend({ type: 'activity_update', activities: myActivities }, origin);
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

      // Server-authoritative voice session check: if we had a voice connection
      // but the server's voiceStates doesn't include us (server restarted and
      // lost in-memory voiceRooms), tear down the stale LiveKit session cleanly.
      // If the server still knows about us (WS blip, not a restart), do nothing —
      // useLiveKit's ConnectionStateChanged handler will re-register if needed.
      {
        const { currentVoiceChannelId } = useVoiceStore.getState();
        if (currentVoiceChannelId) {
          const voiceOrigin = getChannelOrigin(currentVoiceChannelId);
          if (voiceOrigin === origin) {
            const serverKnowsUs = event.voiceStates?.[currentVoiceChannelId]?.includes(event.user.id);
            if (!serverKnowsUs) {
              // leaveVoice() clears currentVoiceChannelId first to prevent
              // AppLayout from auto-reconnecting (disconnect() fires with
              // CLIENT_INITIATED which skips handleForceDisconnect).
              useVoiceStore.getState().leaveVoice();
              getActiveRoom()?.disconnect();
            }
          }
        }
      }

      // Restore DM call state from server (all origins — federated DMs live on remote instances)
      {
        const { activeDmCall, setActiveDmCall, setIncomingCall, incomingCall, connectFn, disconnectFn, setFederatedCallData, setFederatedCallId } = useVoiceStore.getState();
        const myId = event.user.id;
        if (event.activeCalls && event.activeCalls.length > 0) {
          for (const call of event.activeCalls) {
            // For federated calls, check membership via token presence (participants may be empty)
            const isParticipant = call.participants.includes(myId) || !!call.livekitToken;
            if (call.state === 'active' && isParticipant) {
              // Clear any stuck ringing UI from a ringing→active transition during refresh
              setIncomingCall(null);
              // Do NOT set activeDmCall or auto-connect. On refresh/restart, the user
              // is no longer in LiveKit — showing "Connecting..." with no connection
              // is broken UX. The call exists on the server but this client session
              // has no active LiveKit connection. The user can re-initiate if needed.
              break;
            } else if (call.state === 'ringing' && call.callerId !== myId) {
              const dmCh = event.dmChannels?.find((d: any) => d.id === call.dmChannelId);
              const callerUser = dmCh?.members?.find((m: any) => m.id === call.callerId);
              setIncomingCall({
                dmChannelId: call.dmChannelId,
                callerId: call.callerId,
                callerName: callerUser?.displayName || callerUser?.username || call.callerId,
              });
              // Store federated call data for ringing calls too
              if (call.livekitUrl && call.livekitToken) {
                setFederatedCallData(call.livekitToken, call.livekitUrl);
              }
              if (call.federatedCallId) {
                setFederatedCallId(call.federatedCallId);
              }
            }
          }
        } else {
          if (activeDmCall) {
            setActiveDmCall(null);
            if (disconnectFn) disconnectFn();
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

      // Populate rejected peer origins for DM member indicators
      if (isHome) {
        rejectedPeerOrigins.clear();
        if (Array.isArray(event.rejectedPeerOrigins)) {
          for (const o of event.rejectedPeerOrigins) {
            rejectedPeerOrigins.add(o);
          }
        }
      }

      // Populate awaiting-approval peer origins
      if (isHome) {
        awaitingApprovalPeerOrigins.clear();
        if (Array.isArray(event.awaitingApprovalPeerOrigins)) {
          for (const o of event.awaitingApprovalPeerOrigins) {
            awaitingApprovalPeerOrigins.add(o);
          }
        }

        // Populate active peer origins (allowlist for remote DM events)
        activePeerOrigins.clear();
        if (Array.isArray(event.activePeerOrigins)) {
          for (const o of event.activePeerOrigins) {
            activePeerOrigins.add(o);
          }
        }

        // Admin toast for pending approval requests
        if (event.pendingApprovalCount && event.pendingApprovalCount > 0) {
          const { addToast } = useUIStore.getState();
          const count = event.pendingApprovalCount;
          addToast(
            `You have ${count} pending peering request${count === 1 ? '' : 's'}`,
            'info',
            5000,
          );
        }
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
      if (event.message.user) upsertUserView(event.message.user, origin);
      if (event.message.replyTo?.user) upsertUserView(event.message.replyTo.user, origin);
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
      if (event.message.user) upsertUserView(event.message.user, origin);
      if (event.message.replyTo?.user) upsertUserView(event.message.replyTo.user, origin);
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
      if (event.activities) {
        useActivityStore.getState().setUserActivities(event.userId, event.activities);
      }
      break;

    case 'user_updated': {
      if (!isHome) normalizeUserAssets(event.user, origin);
      upsertUserView(event.user, origin);
      useSpaceStore.getState().updateUserEverywhere(event.user);
      useSocialStore.getState().updateFriendProfile(event.user);
      useChatStore.getState().updateUserInMessages(event.user);
      // If this is the current user (other tab changed profile), update authStore
      const myId = isHome
        ? useAuthStore.getState().user?.id
        : getMyUserIdForOrigin(origin);
      if (event.user.id === myId && isHome) {
        // Self-deletion detected on another tab — log out
        if (event.user.isDeleted) {
          useAuthStore.getState().logout();
          break;
        }
        setUser(event.user);
      }

      // Deleted user cleanup: remove from caches the existing pipeline doesn't cover
      if (event.user.isDeleted) {
        useSocialStore.getState().removeFriendLocally(event.user.id, origin);
        useSocialStore.getState().removeRequestsForUser(event.user.id);
        useActivityStore.getState().clearUserActivities(event.user.id);
        useDiscoverStore.getState().removeUser(event.user.id);
        useChatStore.getState().clearTypingForUser(event.user.id);
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

    case 'space_voice_state':
      // A space the user just joined mid-session — bootstrap its current voice
      // presence (occupants, statuses, space/permission mutes). The `ready`
      // payload only carries this at connect time, so without it the new
      // member's channel sidebar shows empty voice channels until a reload.
      // Scoped to event.spaceId; never disturbs other spaces' live voice state.
      applySpaceVoiceState(event);
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
          joinVoiceChannel(event.newChannelId, vs.connectFn ?? undefined);
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
      upsertUserView(event.member.user, origin);
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

    // ─── DM events (all origins) ────────────────────────────────────────────

    case 'dm_message_created': {
      // Gate: only process DM events from the home instance or actively peered origins.
      // This prevents notifications/previews from remote instances where S2S peering
      // was revoked, deleted, or never established — even if the client still has a
      // direct WS connection to that instance via Connections.
      if (!isHome && !activePeerOrigins.has(origin)) {
        break;
      }
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
      if ((event.message as any).user) upsertUserView((event.message as any).user, origin);
      if ((event.message as any).replyTo?.user) upsertUserView((event.message as any).replyTo.user, origin);
      const { dmChannels: currentDmChannels, setDmChannels: setDms, addDmChannel: addDmCh } = useSpaceStore.getState();
      const knownDm = currentDmChannels.find(dm => dm.id === event.message.dmChannelId);

      // Check if this is a relay-created channel that duplicates an existing DM
      // (same conversation, different channel ID). If so, skip adding a new sidebar entry
      // and route the message to the existing channel instead.
      if (!knownDm) {
        // dmAlternatives-based resolution: if this channelId is an alternate-origin
        // local id for a DM whose primary is in dmChannels, reroute to the primary.
        // Covers 1-on-1 AND group DMs uniformly; also the post-failover path where
        // the reconnected original origin's WS still uses its old local id.
        const primaryId = resolveDmChannelId(event.message.dmChannelId);
        if (primaryId && primaryId !== event.message.dmChannelId) {
          addRealtimeMessage(primaryId, { ...event.message, dmChannelId: primaryId } as any);
          const updatedDms = currentDmChannels.map(dm =>
            dm.id === primaryId ? { ...dm, lastMessage: event.message } : dm,
          );
          const { unreadChannels: u1, currentChannelId: c1 } = useChatStore.getState();
          setDms(sortDmChannels(updatedDms, u1, c1));
          {
            const { currentChannelId: u1cc, markChannelUnread: u1mu } = useChatStore.getState();
            const myId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
            if (primaryId !== u1cc && event.message.userId !== myId) {
              u1mu(primaryId);
            }
          }
          break;
        }

        // Legacy 2-member-identity fallback: covers DMs without a federatedId
        // (pre-federation or never-federated 1-on-1 DMs).
        const msgUser = event.message.user;
        const msgHomeUserId = msgUser?.homeUserId || msgUser?.id;
        if (msgHomeUserId) {
          const existingDm = currentDmChannels.find(dm =>
            dm.members.length === 2 &&
            dm.members.some(m => (m.homeUserId || m.id) === msgHomeUserId),
          );
          if (existingDm) {
            // Route message to the existing channel instead of creating a duplicate
            addRealtimeMessage(existingDm.id, { ...event.message, dmChannelId: existingDm.id } as any);
            const updatedDms = currentDmChannels.map(dm =>
              dm.id === existingDm.id ? { ...dm, lastMessage: event.message } : dm,
            );
            const { unreadChannels, currentChannelId } = useChatStore.getState();
            setDms(sortDmChannels(updatedDms, unreadChannels, currentChannelId));
            break;
          }
        }
      }

      addRealtimeMessage(event.message.dmChannelId, event.message as any);
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
        const { unreadChannels: unread, currentChannelId: curCh } = useChatStore.getState();
        setDms(sortDmChannels(updatedDms, unread, curCh));
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
      if (!isHome && !activePeerOrigins.has(origin)) break;
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
      if ((event.message as any).user) upsertUserView((event.message as any).user, origin);
      if ((event.message as any).replyTo?.user) upsertUserView((event.message as any).replyTo.user, origin);
      updateMessage(event.message as any);
      break;

    case 'federation_file_rejected': {
      const { addToast } = useUIStore.getState();
      const users = event.affectedUsers;
      if (users && users.length > 0) {
        const parts = users.map(u => {
          const limitMb = Math.round(u.limit / (1024 * 1024));
          return `${u.username}'s instance (limit: ${limitMb} MB)`;
        });
        const msg = `File couldn't be cached on ${parts.join(' and ')}. They can still view it from yours.`;
        addToast(msg, 'warning', 7000);
      }
      break;
    }

    case 'federation_peer_rejected': {
      const { addToast } = useUIStore.getState();
      rejectedPeerOrigins.add(event.peerOrigin);
      awaitingApprovalPeerOrigins.delete(event.peerOrigin);
      activePeerOrigins.delete(event.peerOrigin);
      const label = event.peerLabel || event.peerOrigin;
      addToast(
        `Cannot relay messages to ${label} — ${event.reason}`,
        'warning',
        10000,
      );
      notifyFederationChangeListeners();
      break;
    }

    case 'federation_peer_active': {
      rejectedPeerOrigins.delete(event.peerOrigin);
      awaitingApprovalPeerOrigins.delete(event.peerOrigin);
      activePeerOrigins.add(event.peerOrigin);
      notifyFederationChangeListeners();
      break;
    }

    case 'federation_peers_changed': {
      notifyFederationChangeListeners();
      break;
    }

    case 'federation_peer_reset_detected': {
      for (const cb of federationPeerResetDetectedListeners) cb(event.origin);
      break;
    }

    case 'federation_approval_request_received': {
      notifyFederationChangeListeners();
      break;
    }

    case 'peering_subscription_changed': {
      // The user's pending peering-subscription set changed (admin approved/
      // denied/expired the parent request, or the user cancelled a row from
      // another tab). Refetch — the server is the source of truth.
      void useFederationStore.getState().refetchPeeringSubscriptions();
      break;
    }

    case 'peering_notification_received': {
      // Terminal-state outcome arrived for one of the user's outbound peering
      // requests. Refetch the notifications list and surface a transient
      // toast — the inline list in the Connections panel is the persistent
      // surface; the toast is opportunistic for online users.
      void useFederationStore.getState().refetchPeeringNotifications();
      const message =
        event.kind === 'approved'
          ? 'Your peering request was approved'
          : event.kind === 'denied'
            ? 'Your peering request was denied'
            : 'Your peering request expired';
      // uiStore exposes 'info' | 'warning' | 'success' — use 'success' for
      // approved, 'warning' for denied/expired (no error severity exists).
      const severity: 'success' | 'warning' = event.kind === 'approved' ? 'success' : 'warning';
      useUIStore.getState().addToast(message, severity, 4500);
      break;
    }

    case 'dm_message_deleted':
      if (!isHome && !activePeerOrigins.has(origin)) break;
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
      if (!isHome && !activePeerOrigins.has(origin)) break;
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
      if (!isHome && !activePeerOrigins.has(origin)) break;
      let dmTypingUsername = event.username as string;
      if (!isHome && dmTypingUsername && !dmTypingUsername.includes('@')) {
        try { dmTypingUsername = `${dmTypingUsername}@${new URL(origin).host}`; } catch {}
      }
      setTyping(event.dmChannelId, event.userId, dmTypingUsername);
      break;
    }

    case 'dm_typing_stop': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      clearTyping(event.dmChannelId as string, event.userId as string);
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
      if (event.request.user) upsertUserView(event.request.user, origin);
      const { addIncomingRequest } = useSocialStore.getState();
      addIncomingRequest(event.request, origin);
      break;
    }

    case 'friend_request_sent': {
      // Multi-tab sync: another tab/device of the same user just created an outbound request.
      if (!isHome && event.request.user) normalizeUserAssets(event.request.user, origin);
      if (event.request.user) upsertUserView(event.request.user, origin);
      const { addOutboundRequest } = useSocialStore.getState();
      addOutboundRequest(event.request, origin);
      break;
    }

    case 'friend_request_relay_failed': {
      // Async rollback notification: the federated friend_request_create was permanently rejected.
      // Drop the optimistic row and surface a warning toast.
      const { removeRequestById } = useSocialStore.getState();
      removeRequestById(event.requestId, origin);
      const { addToast } = useUIStore.getState();
      addToast(
        `Friend request to ${event.targetHandle} could not be delivered: ${event.message}`,
        'warning',
      );
      break;
    }

    case 'friend_request_accepted': {
      if (!isHome) normalizeUserAssets(event.friend, origin);
      // Friend carries the identity fields the cache needs; cast to User for upsert.
      upsertUserView(event.friend as unknown as User, origin);
      const { addFriendFromAccepted } = useSocialStore.getState();
      addFriendFromAccepted(event.friend, event.requestId, origin);
      import('../stores/discoverStore').then(({ useDiscoverStore }) => {
        useDiscoverStore.getState().updateRelationship(event.friend.id, origin, 'friends');
      });
      break;
    }

    case 'friend_removed': {
      const { removeFriendLocally } = useSocialStore.getState();
      removeFriendLocally(event.userId, origin);
      import('../stores/discoverStore').then(({ useDiscoverStore }) => {
        useDiscoverStore.getState().updateRelationship(event.userId, origin, 'none');
      });
      break;
    }

    case 'friend_request_cancelled': {
      const { removeRequestById } = useSocialStore.getState();
      removeRequestById(event.requestId, origin, event.userId);
      import('../stores/discoverStore').then(({ useDiscoverStore }) => {
        useDiscoverStore.getState().updateRelationship(event.userId, origin, 'none');
      });
      break;
    }

    case 'friend_request_declined': {
      const { removeRequestById } = useSocialStore.getState();
      removeRequestById(event.requestId, origin, event.userId);
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
      if (!isHome && !activePeerOrigins.has(origin)) break;
      // Batch ALL call state into a single set() to prevent:
      // 1. Ringtone multiplication (multiple subscription triggers from separate set() calls)
      // 2. Stale callOrigin/federatedCallId from previous calls (always overwritten)
      // callOrigin = the WS origin that delivered this event, NOT event.callOrigin (the host).
      // Routing accept/reject through this WS ensures the message reaches a connected server,
      // which then relays to the host via S2S HTTP. Using event.callOrigin (the host URL)
      // would route through the multi-instance WS, which may not be connected.
      useVoiceStore.setState({
        incomingCall: {
          dmChannelId: event.dmChannelId ?? null,
          callerId: event.callerId,
          callerName: event.callerName,
        },
        federatedCallToken: event.livekitToken ?? null,
        federatedCallUrl: event.livekitUrl ?? null,
        federatedCallId: event.federatedCallId ?? null,
        callOrigin: origin,
      });
      break;
    }

    case 'dm_call_accepted': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      const { setIncomingCall, setOutgoingCall, outgoingCall, setActiveDmCall, connectFn, isLiveKitConnected } = useVoiceStore.getState();
      const wasOutgoingCall = !!outgoingCall;
      setIncomingCall(null);
      setOutgoingCall(null);

      // Only enter active call state if:
      // - We're the caller (wasOutgoingCall) → will connect via connectFn below
      // - We already connected to LiveKit (clicked accept in handleAccept)
      // Other instances of the same user must NOT enter call state — they'd show
      // "Connecting..." forever with no actual LiveKit connection.
      const callDmId = event.dmChannelId || event.federatedCallId || '';
      if (wasOutgoingCall || isLiveKitConnected) {
        setActiveDmCall({ dmChannelId: callDmId });
      }
      // The caller connects to the DM room. `wasOutgoingCall` alone identifies
      // the caller session (other sessions/tabs never set outgoingCall), and
      // `connect()` de-dupes an already-connected same room — so we must NOT
      // also gate on `!isLiveKitConnected`: a caller who is currently sitting in
      // a space voice channel is LiveKit-connected, and gating on it would skip
      // the DM connect entirely, stranding them in the space channel.
      if (connectFn && wasOutgoingCall && callDmId) {
        connectFn(callDmId, true).catch((err: unknown) => {
          console.error('[WS] DM call connect failed:', err);
        });
      }
      break;
    }

    case 'dm_call_rejected': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      teardownDmCall();
      break;
    }

    case 'dm_call_ended': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      teardownDmCall();
      break;
    }

    case 'dm_call_undeliverable': {
      if (!isHome && !activePeerOrigins.has(origin)) break;

      const { addToast } = useUIStore.getState();

      if (event.terminal) {
        // Tear down local outbound call state — mirrors dm_call_ended.
        teardownDmCall();
      }

      const msg = buildCallUndeliverableToast(event.failures, event.terminal, event.phase);
      addToast(msg, event.terminal ? 'warning' : 'info', 8_000);
      break;
    }

    // ─── DM channel events (all origins) ────────────────────────────────────

    case 'dm_channel_created': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      if (!isHome) {
        for (const m of event.dmChannel.members) {
          normalizeUserAssets(m, origin);
        }
      }
      for (const m of event.dmChannel.members) {
        upsertUserView(m, origin);
      }
      // Dedup: skip if a channel with the same federatedId already exists
      const fid = event.dmChannel.federatedId;
      if (fid) {
        const existing = useSpaceStore.getState().dmChannels.find(dm => dm.federatedId === fid);
        if (existing) break;
      }
      addDmChannel(event.dmChannel, origin);
      break;
    }

    case 'dm_channel_closed':
      if (!isHome && !activePeerOrigins.has(origin)) break;
      removeDmChannel(event.dmChannelId);
      break;

    case 'dm_member_added': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      if (!isHome) normalizeUserAssets(event.user, origin);
      upsertUserView(event.user, origin);
      const { addDmMember } = useSpaceStore.getState();
      addDmMember(event.dmChannelId, event.user);
      break;
    }

    case 'dm_member_removed': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      const { removeDmMember } = useSpaceStore.getState();
      removeDmMember(event.dmChannelId, event.userId);
      break;
    }

    case 'dm_owner_updated': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
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
      break;
    }

    case 'dm_channel_updated': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      const { dmChannelId, name, icon } = event;
      useSpaceStore.getState().updateDmMetadata(dmChannelId, { name, icon });
      break;
    }

    // ─── Channel/space events (all origins) ─────────────────────────────────

    case 'channel_created': {
      useSpaceStore.getState().upsertChannel(event.channel, event.spaceId, origin);
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

/** Send an event to ALL connected WebSocket instances (home + remotes). */
export function wsSendAll(event: ClientEvent): void {
  for (const [_origin, conn] of connections) {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(event));
    }
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
