import { receiveChannelPoke } from '../components/chat/channelPoke';
import { useChannelPokeStore } from '../components/chat/channelPokeStore';
import React, { useEffect, useRef } from 'react';
import { isMyIdentity, useAuthStore } from '../stores/authStore';
import { useSpaceStore, getChannelOrigin, getMyUserIdForOrigin } from '../stores/spaceStore';
import { useChatStore } from '../stores/chatStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useSocialStore } from '../stores/socialStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { ServerEvent, ClientEvent, ActiveCallInfo, Activity, FederatedIdentity, User } from '@backspace/shared';
import { resolveAssetUrl, normalizeUserAssets, normalizeMessageAssets } from '../utils/assetUrls';
import { broadcastVoiceStatus, broadcastDeafenViaLiveKit } from '../utils/voice';
import { dmCallCredentialsFrom, dmCallIds, dmCallOrigin, dmCallRefFrom, dmCallRoomKey } from '../utils/dmCall';
import { turnCameraOnInDmCall } from '../utils/voiceActions';
import { applySpaceVoiceState } from '../utils/voiceStateSync';
import { applyIncomingDmMessage, applyIncomingDmChannel } from '../utils/dmMessageRouting';
import { ownStatusReport, statusToAssertOnRemote } from '../utils/selfStatus';
import { getActiveRoom } from './useLiveKit';
import { useUIStore } from '../stores/uiStore';
import { describeErrorCode } from '../i18n/errors';
import { useActivityStore } from '../stores/activityStore';
import { presenceSubjectOf, readyActivityEntries, readyRowIndex } from '../utils/presenceSubject';
import { useDiscoverStore } from '../stores/discoverStore';
import { useFederationStore } from '../stores/federationStore';
import { notePendingOriginReady } from '../stores/pendingMessageRehydrate';
import { useNotificationSettingsStore } from '../stores/notificationSettingsStore';
import { detectClientKind } from '../platform/clientKind';
import { ConnectionState as LiveKitConnectionState } from 'livekit-client';

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
import { peerRejectedToast } from '../utils/peerRejectedToast';

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
  // Never tear down a space voice connection in response to a DM-call signal.
  if (voice.disconnectFn && !voice.currentVoiceChannelId) voice.disconnectFn();
}

/**
 * Whether a `dm_call_ended` / `dm_call_rejected` is about the call this client
 * holds (ringing in, ringing out or joined). Every member of a DM hears that
 * its call ended, and a group decline is told to the decliner; neither may
 * tear down a different call the client is in. The event names the call by
 * the sending instance's DM id, by the conversation key, or both, and a slot
 * may hold either, so the DM ids are also compared through their keys.
 */
export function dmCallEventIsOurs(event: DmCallEventIds): boolean {
  const { incomingCall, outgoingCall, activeDmCall } = useVoiceStore.getState();
  // Each slot carries the ids of its own call, so an id a past ring left
  // behind can never make another call's event look like this one's.
  const held: string[] = [];
  if (incomingCall) held.push(...dmCallIds(incomingCall));
  if (outgoingCall) held.push(outgoingCall.dmChannelId);
  if (activeDmCall) held.push(...dmCallIds(activeDmCall));
  return dmCallEventNames(event, held);
}

type DmCallEventIds = { dmChannelId: string | null; federatedCallId?: string | null };

/**
 * Whether `event` names the call one slot holds under `held` (its DM id, its
 * key, or both). The event may name it by the sending instance's DM id, by
 * the conversation key, or both, so DM ids are also compared through their
 * keys.
 */
function dmCallEventNames(event: DmCallEventIds, held: readonly string[]): boolean {
  if (held.length === 0) return false;
  const { dmChannels } = useSpaceStore.getState();
  const keyOf = (dmChannelId: string): string | null => dmChannels.find(d => d.id === dmChannelId)?.federatedId ?? null;
  const named = new Set<string>();
  if (event.dmChannelId) {
    named.add(event.dmChannelId);
    const key = keyOf(event.dmChannelId);
    if (key) named.add(key);
  }
  if (event.federatedCallId) named.add(event.federatedCallId);

  for (const id of held) {
    if (named.has(id)) return true;
    const key = keyOf(id);
    if (key && named.has(key)) return true;
  }
  return false;
}

/**
 * Whether a `dm_call_accepted` stops this client's ring: it names the call
 * that is ringing, and the member who answered is the signed-in user (another
 * of their sessions), compared by federated identity. In a group call another
 * member's answer leaves the ring on, so this member can still answer. An
 * event from a server up to 1.9.0 does not say who answered and stops it, as
 * it always did.
 */
export function acceptStopsRing(event: DmCallEventIds & { answeredBy?: FederatedIdentity }): boolean {
  const { incomingCall } = useVoiceStore.getState();
  if (!incomingCall || !dmCallEventNames(event, dmCallIds(incomingCall))) return false;
  return !event.answeredBy || isMyIdentity(event.answeredBy);
}

/**
 * Whether `spaceId`, as `origin` issued it, is the space whose roster
 * `spaceStore.members` holds: the open space (`loadSpaceDetail` sets both).
 * `members` is one space's roster, so a join or leave in any other space, or
 * in a space of the same id on another instance, is not about it.
 */
function isLoadedRosterSpace(spaceId: string, origin: string): boolean {
  const { currentSpaceId, spaces } = useSpaceStore.getState();
  if (spaceId !== currentSpaceId) return false;
  return (spaces.find(s => s.id === spaceId)?._instanceOrigin ?? '') === origin;
}

/**
 * `readyAlreadyDelivered`: this socket has delivered a `ready` before. A later
 * one on the same socket is a state refresh (instances up to 1.7.0 send one
 * as a permission refresh), not a new session: no event was missed.
 */
function handleEvent(origin: string, event: ServerEvent, readyAlreadyDelivered = false): void {
  const isHome = origin === HOME_ORIGIN;
  const { setUser } = useAuthStore.getState();
  const { populateFromReady, loadSpaceDetail, currentSpaceId, updateMemberPresence, addMember, removeMember, removeDmChannel, upsertUserView } = useSpaceStore.getState();
  const { addMessage, addRealtimeMessage, updateMessage, removeMessage, setTyping, clearTyping, onReactionAdded, onReactionRemoved } = useChatStore.getState();
  const { addVoiceUser, removeVoiceUser, clearVoiceUsersForOrigin, setVoiceUsers, setVoiceChannelElapsedSeconds, setVoiceUserStatus, clearVoiceUserStatus } = useVoiceStore.getState();

  switch (event.type) {
    case 'channel_poke_failed':
      useUIStore.getState().addToast(event.message, 'warning');
      break;
    case 'channel_poke':
      receiveChannelPoke(origin, event);
      break;
    case 'ready':
      useChannelPokeStore.getState().setHost(origin, event.supportsPoke === true);
      // This instance names the signed-in user's row there (the home's is the
      // session row itself, set below). The one record of "my ids".
      if (!isHome) useAuthStore.getState().recordMyRow(origin, event.user.id);

      if (isHome) {
        setUser(event.user);
        useSettingsStore.getState().setIsAdmin(event.user.isAdmin ?? false);
        useSettingsStore.getState().fetchStreamingLimits();
        useSettingsStore.getState().fetchGifEnabled();
        // Whose acknowledgements to read: the store cannot import authStore
        // without dragging the audio pipeline into every settings test.
        useSettingsStore.getState().setUpdateAckUser(event.user.id);
        // This is what moved the release lookup off the Updates panel: the dot
        // has to be able to appear before an admin ever navigates there. Gated
        // on the flag this event just delivered, not on store state.
        if (event.user.isAdmin === true) {
          void useSettingsStore.getState().fetchUpdateStatus();
        }
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

      // The DM part goes through the merge module, whose pin rule moves a
      // conversation first listed from a sibling to its home copy.
      populateFromReady(origin, event.spaces, event.folders, event.dmChannels, event.spaceLayout, event.layoutUpdatedAt);
      // Pending messages restored at boot wait for the ready that lists their channel.
      notePendingOriginReady(origin);
      // This instance's notification settings for the spaces it hosts, read
      // by the alert filter (docs/systems/sounds.md).
      void useNotificationSettingsStore.getState().load(origin);

      // The user's own chosen status (utils/selfStatus.ts): take it from this
      // socket when it is the owner's report (the true home, for a session on
      // a replicated row), and re-send it to this remote when this session owns
      // the choice and the remote account is the same federated identity.
      {
        const authUser = useAuthStore.getState().user;
        const report = ownStatusReport(authUser, { origin, isHome }, { userId: event.user.id, status: event.user.status });
        if (report) useAuthStore.getState().applyOwnStatus(report);
        if (!isHome) {
          const status = statusToAssertOnRemote(authUser, event.user);
          if (status) wsSend({ type: 'presence_update', status }, origin);
        }
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
      // (fixes race condition on page reload — route params effect fires before remote WS connects).
      // Its open channel's messages are loaded by the session rule below.
      if (!isHome) {
        const { currentSpaceId: curSpaceId, loadSpaceDetail: loadDetail } = useSpaceStore.getState();
        if (curSpaceId && event.spaces.some((s: any) => s.id === curSpaceId)) {
          loadDetail(curSpaceId);
        }
      }

      // A new session, home or remote, may have missed messages while
      // disconnected: clear the message cache for all channels on this origin
      // so the next visit does a fresh fetch, and force-reload the open
      // channel now (its view keeps its anchor, docs/systems/message-list.md).
      // On a page reload this is also the first load of a remote channel
      // opened before its origin's socket was ready. A refresh ready on a
      // live socket missed nothing, so the cache and the open view stay as
      // they are.
      if (!readyAlreadyDelivered) {
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
      if (event.voiceChannelElapsedSeconds) {
        for (const [channelId, elapsedSeconds] of Object.entries(event.voiceChannelElapsedSeconds)) {
          setVoiceChannelElapsedSeconds(channelId, elapsedSeconds);
        }
      }
      // Activity data from the ready payload: this origin's full snapshot,
      // replacing whatever it reported before the reconnect.
      {
        const olderServerRows = readyRowIndex(event);
        useActivityStore.getState().setOriginRows(origin, olderServerRows);
        if (event.userActivities) {
          useActivityStore.getState().initActivities(readyActivityEntries(event), origin, olderServerRows);
        }
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
              const activeRoom = getActiveRoom();
              const localStatus = useVoiceStore.getState().voiceConnectionStatus;
              const recoverable = localStatus === 'connecting'
                || localStatus === 'reconnecting'
                || (activeRoom != null && (
                  activeRoom.state === LiveKitConnectionState.Connected
                  || activeRoom.state === LiveKitConnectionState.Connecting
                  || activeRoom.state === LiveKitConnectionState.Reconnecting
                ));
              if (recoverable) {
                // A ready snapshot can race the new socket's voice
                // registration. Reassert the session and keep LiveKit's own
                // reconnect machinery and local media intent intact.
                wsSend({ type: 'voice_join', channelId: currentVoiceChannelId }, origin);
                broadcastVoiceStatus(origin);
              }
              // A completed network disconnect intentionally retains the
              // channel ID for the Retry action. Absence from a ready snapshot
              // alone is not a terminal refusal, so leave that intent intact.
            }
          }
        }
      }

      // Active DM calls do not use voice_join. Re-sending voice_status lets the
      // server bind the new socket while its DM participant is still in grace.
      {
        const state = useVoiceStore.getState();
        if (state.activeDmCall && dmCallOrigin(state.activeDmCall) === origin) {
          broadcastVoiceStatus(origin);
        }
      }

      // Restore DM call state from server (all origins — federated DMs live on remote instances)
      {
        const { activeDmCall, setActiveDmCall, setIncomingCall, incomingCall, disconnectFn } = useVoiceStore.getState();
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
              // The ring is this origin's: its answer goes back here, with
              // the ids and credentials it came with.
              const ref = dmCallRefFrom(call, origin);
              if (!ref) continue;
              const dmCh = event.dmChannels?.find((d: any) => d.id === call.dmChannelId);
              const callerUser = dmCh?.members?.find((m: any) => m.id === call.callerId);
              setIncomingCall({
                ...ref,
                callerId: call.callerId,
                callerName: callerUser?.displayName || callerUser?.username || call.callerId,
                livekit: dmCallCredentialsFrom(call.livekitUrl, call.livekitToken),
              });
            }
          }
        } else {
          // This origin reports no call. Only a call that goes through it is
          // gone; a call through another connection is that one's to report.
          if (activeDmCall && dmCallOrigin(activeDmCall) === origin) {
            setActiveDmCall(null);
            if (disconnectFn) disconnectFn();
          }
          if (incomingCall && dmCallOrigin(incomingCall) === origin) {
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
        if (event.message.type !== 'system' && event.message.channelId !== currentChannelId && event.message.userId !== myId && !voiceChannelIds.has(event.message.channelId)) {
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

    case 'presence_update': {
      // The owner's report of the user's own status, e.g. a change made on
      // another device (utils/selfStatus.ts); feeds the alert gate.
      const report = ownStatusReport(useAuthStore.getState().user, { origin, isHome }, event);
      if (report) useAuthStore.getState().applyOwnStatus(report);
      // Members, friends and activities are keyed by the subject's home
      // identity, so a replicated row's delivery and the home's native
      // delivery agree (#340), and a same-id row of another instance is not
      // mistaken for them.
      const subject = presenceSubjectOf(event, origin);
      updateMemberPresence(subject, origin, event.status);
      useSocialStore.getState().updateFriendPresence(subject, origin, event.status);
      if (event.activities) {
        useActivityStore.getState().setUserActivities(subject, origin, event.activities);
      }
      break;
    }

    case 'user_updated': {
      if (!isHome) normalizeUserAssets(event.user, origin);
      upsertUserView(event.user, origin);
      useSpaceStore.getState().updateUserEverywhere(event.user, origin);
      useSocialStore.getState().updateFriendProfile(event.user, origin);
      useChatStore.getState().updateUserInMessages(event.user, origin);
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
      {
        // The true home's row of a replicated session carries the choice too.
        const report = ownStatusReport(useAuthStore.getState().user, { origin, isHome }, { userId: event.user.id, status: event.user.status });
        if (report) useAuthStore.getState().applyOwnStatus(report);
      }

      // Deleted user cleanup: remove from caches the existing pipeline doesn't cover
      if (event.user.isDeleted) {
        // Each removal goes through userUpdateReach, as the updates above do.
        useSocialStore.getState().removeDeletedUser(event.user, origin);
        useActivityStore.getState().clearUserActivities(event.user, origin);
        useDiscoverStore.getState().removeDeletedUser(event.user, origin);
        useChatStore.getState().clearTypingForDeletedUser(event.user, origin);
      }
      break;
    }

    case 'voice_state_update':
      if (event.action === 'join') {
        addVoiceUser(event.channelId, event.userId);
        if (event.channelElapsedSeconds !== undefined) {
          setVoiceChannelElapsedSeconds(event.channelId, event.channelElapsedSeconds);
        }
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
      if (isLoadedRosterSpace(event.spaceId, origin)) addMember(event.spaceId, event.member);
      break;

    case 'member_left':
      if (isLoadedRosterSpace(event.spaceId, origin)) removeMember(event.spaceId, event.userId);
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
      void applyIncomingDmMessage(origin, event.message);
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
      addToast(peerRejectedToast(event), 'warning', 10000);
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
      // The ring's ids, origin and credentials live on the incoming slot
      // alone, set in one set() (one ringtone trigger). A call the client is
      // in keeps its own. The origin is the WS that delivered this event, not
      // event.callOrigin (the host): accept and decline go through this
      // connected server, which relays them to the host; the host's URL
      // would route through a multi-instance WS that may not be connected.
      {
        const ref = dmCallRefFrom({ dmChannelId: event.dmChannelId ?? null, federatedCallId: event.federatedCallId }, origin);
        if (!ref) break;
        useVoiceStore.setState({
          incomingCall: {
            ...ref,
            callerId: event.callerId,
            callerName: event.callerName,
            livekit: dmCallCredentialsFrom(event.livekitUrl, event.livekitToken),
          },
        });
      }
      break;
    }

    case 'dm_call_accepted': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      // Every member of a DM hears each accept, late joins of a group call
      // included. Only the call this client holds changes state: a member
      // calling another DM, or sitting in a voice channel, stays where it is.
      if (!dmCallEventIsOurs(event)) break;
      const { setIncomingCall, setOutgoingCall, outgoingCall, activeDmCall, setActiveDmCall, connectFn } = useVoiceStore.getState();
      // The ring stops only when this user answered, on another session. The
      // calling tone stops on any answer to the call this session placed.
      if (acceptStopsRing(event)) setIncomingCall(null);
      const answersOutgoing = !!outgoingCall && dmCallEventNames(event, [outgoingCall.dmChannelId]);
      if (answersOutgoing) setOutgoingCall(null);

      // Only the caller enters the call here: its session is the only one
      // with `outgoingCall`, and it connects below. A client that accepted or
      // joined set `activeDmCall` in the click already. Any other session of
      // the same user (the call was answered on another device) stays out:
      // being LiveKit-connected says nothing about this call, since that
      // session may be sitting in a voice channel.
      // A call already held keeps the id it is held by. The event may name it
      // by another instance's DM id (a client that hears both the host and its
      // home), and the hang-up must go out under the held id.
      if (!activeDmCall && outgoingCall && answersOutgoing) {
        const call = { dmChannelId: outgoingCall.dmChannelId, federatedCallId: null, callOrigin: null, livekit: null };
        setActiveDmCall(call);
        // The caller connects to the DM room. `connect()` de-dupes an
        // already-connected same room, so this is not gated on
        // `!isLiveKitConnected`: a caller sitting in a space voice channel is
        // LiveKit-connected, and gating on it would strand them there.
        if (connectFn) {
          const roomKey = dmCallRoomKey(call);
          connectFn(roomKey, true)
            .then(() => (outgoingCall.withCamera ? turnCameraOnInDmCall(roomKey) : undefined))
            .catch((err: unknown) => {
              console.error('[WS] DM call connect failed:', err);
            });
        }
      }
      break;
    }

    case 'dm_call_rejected': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      if (dmCallEventIsOurs(event)) teardownDmCall();
      break;
    }

    case 'dm_call_ended': {
      if (!isHome && !activePeerOrigins.has(origin)) break;
      // The call is over: nobody is in it any more, whatever leave events an
      // older server did not send.
      if (event.dmChannelId) setVoiceUsers(event.dmChannelId, []);
      if (dmCallEventIsOurs(event)) teardownDmCall();
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
      applyIncomingDmChannel(origin, event.dmChannel);
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
      // Also how a channel comes back into view after an override change,
      // in whichever space: the index entry is written wherever the space is.
      useSpaceStore.getState().upsertChannel(event.channel, event.spaceId, origin);
      break;
    }

    case 'channel_deleted': {
      // Deleted, or hidden from this user by an override change.
      useSpaceStore.getState().removeChannel(event.channelId);
      if (useChatStore.getState().currentChannelId === event.channelId) {
        useChatStore.getState().setCurrentChannel(null);
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

    case 'category_created':
    case 'category_updated': {
      useSpaceStore.getState().upsertCategory(event.category, origin);
      break;
    }

    case 'category_deleted': {
      useSpaceStore.getState().removeCategory(event.categoryId, event.spaceId, origin);
      break;
    }

    case 'channel_layout_updated': {
      useSpaceStore.getState().applyChannelLayout(event.spaceId, origin, event.channels, event.categories);
      break;
    }

    case 'notification_settings_updated': {
      // Settings live on the instance that hosts the space, so the socket
      // that delivered the change is the origin they belong to.
      useNotificationSettingsStore.getState().apply(origin, event.setting);
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

    case 'space_access_changed':
      void refreshSpaceAccess(origin, event.spaceId);
      break;

    case 'error': {
      console.error(`WebSocket error (${origin || 'home'}):`, event.message);
      // A refused dm_call_start names its DM: the call this client is placing
      // there never started, so the calling state and its ring go. A refused
      // dm_call_accept names the call the client joined on its side before
      // the answer (the call had ended, or the user is not a member), so the
      // client leaves it.
      if (event.dmChannelId) {
        const { outgoingCall, setOutgoingCall, activeDmCall } = useVoiceStore.getState();
        if (outgoingCall?.dmChannelId === event.dmChannelId
            && getChannelOrigin(event.dmChannelId) === origin) {
          setOutgoingCall(null);
        }
        // The refusal names the call by the id the accept sent: the DM's
        // id, or the call's key when there was none.
        if ((event.code === 'dm_call_not_found' || event.code === 'not_dm_member')
            && activeDmCall && dmCallRoomKey(activeDmCall) === event.dmChannelId
            && dmCallOrigin(activeDmCall) === origin) {
          teardownDmCall();
        }
      }
      // A coded error is the refusal of something the user just did (a voice
      // moderation action the role hierarchy refuses, for one); say so. Older
      // servers send no code, and those errors stay in the log.
      if (event.code) {
        useUIStore.getState().addToast(describeErrorCode(event.code, event.message, event.details), 'warning');
      }
      break;
    }
  }
}

/**
 * `space_access_changed` (websocket.md): the space's roles or a member's roles
 * changed, so what the viewer may see or do there may have changed too. The
 * space's detail is fetched again without the loading state, so nothing
 * flashes and no message cache is touched. Every channel it lists goes
 * through `upsertChannel`, so one the viewer can now see is known wherever
 * channels are looked up; one it no longer lists is gone for this viewer and
 * goes through the same path as a deleted channel.
 */
async function refreshSpaceAccess(origin: string, spaceId: string): Promise<void> {
  const { spaces, loadSpaceDetail } = useSpaceStore.getState();
  if (!spaces.some(s => s.id === spaceId && (s._instanceOrigin ?? '') === origin)) return;
  const { channelToSpaceMap, channelOriginMap } = useSpaceStore.getState();
  const known = [...channelToSpaceMap]
    .filter(([channelId, sId]) => sId === spaceId && (channelOriginMap.get(channelId) ?? '') === origin)
    .map(([channelId]) => channelId);
  const visible = await loadSpaceDetail(spaceId, { quiet: true });
  if (!visible) return;
  const { upsertChannel } = useSpaceStore.getState();
  for (const channel of visible) upsertChannel(channel, spaceId, origin);
  const visibleIds = new Set(visible.map(c => c.id));
  for (const channelId of known) {
    if (!visibleIds.has(channelId)) handleEvent(origin, { type: 'channel_deleted', channelId, spaceId });
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
    ws.send(JSON.stringify({ type: 'auth', token: conn.token, client: detectClientKind() }));
    startHeartbeat(conn);
  };

  // Whether this socket has delivered its session's `ready` yet.
  let readyDelivered = false;
  ws.onmessage = (e) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(e.data as string) as ServerEvent;
    } catch {
      console.error(`Failed to parse WebSocket message (${origin || 'home'})`);
      return;
    }
    const readyAlreadyDelivered = readyDelivered;
    if (event.type === 'ready') readyDelivered = true;
    try {
      handleEvent(origin, event, readyAlreadyDelivered);
    } catch (err) {
      console.error('Error handling WS event "%s" (%s):', event.type, origin || 'home', err);
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

/**
 * Send an event over the origin's WebSocket. Can be used outside of React
 * components. Returns whether the event was handed to an open socket; when
 * the origin has none (not connected, or reconnecting) the event is dropped
 * and the result is false.
 */
export function wsSend(event: ClientEvent, origin: string = HOME_ORIGIN): boolean {
  const conn = connections.get(origin);
  if (conn?.ws && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(event));
    return true;
  }
  return false;
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
