import type { Activity, ActiveCallInfo, ServerEvent } from '@backspace/shared';
import { ConnectionState as LiveKitConnectionState } from 'livekit-client';
import { useActivityStore } from '../stores/activityStore';
import { useAuthStore } from '../stores/authStore';
import { useChannelActivityStore } from '../stores/channelActivityStore';
import { useChatStore } from '../stores/chatStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSocialStore } from '../stores/socialStore';
import { getChannelOrigin, setMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { normalizeUserAssets, resolveAssetUrl } from '../utils/assetUrls';
import { registerSelfId } from '../utils/identity';
import { ownStatusReport, statusToAssertOnRemote } from '../utils/selfStatus';
import { broadcastVoiceStatus } from '../utils/voice';
import { readyActivityEntries, readyRowIndex } from '../utils/presenceSubject';
import { getActiveRoom } from './useLiveKit';
import { wsSend } from './useWebSocket';
import { activePeerOrigins, awaitingApprovalPeerOrigins, rejectedPeerOrigins } from './webSocketFederationEvents';

type ReadyEvent = Extract<ServerEvent, { type: 'ready' }>;

/** Preserve hydration order; each phase owns one store or connection concern. */
export function handleReady(origin: string, event: ReadyEvent): void {
  const { currentSpaceId } = useSpaceStore.getState();
  initializeReadyAccount(origin, event);
  normalizeReadySpaces(origin, event);
  populateReadySpaces(origin, event);
  syncReadyIdentity(origin, event);
  reloadReadySpace(origin, event, currentSpaceId);
  resetReadyMessages(origin, event);
  hydrateReadyReadStates(origin, event);
  hydrateReadyVoicePresence(origin, event);
  hydrateReadyActivities(origin, event);
  hydrateReadyVoiceRestrictions(origin, event);
  reconcileReadyVoiceSession(origin, event);
  restoreReadyCalls(origin, event);
  hydrateReadySocial(origin, event);
}

function initializeReadyAccount(origin: string, event: ReadyEvent): void {
  const isHome = origin === '';
  const { setUser } = useAuthStore.getState();
  useNotificationStore.getState().hydrate({ origin, userId: event.user.id, spaces: event.spaces, settings: event.notificationSettings ?? [] });
  // Register this user's ID for cross-instance self-identification
  registerSelfId(event.user.id);

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
}

function normalizeReadySpaces(origin: string, event: ReadyEvent): void {
  if (origin === '') return;
  // Normalize remote assets before any store receives them.
  for (const space of event.spaces) {
    if (space.icon) space.icon = resolveAssetUrl(space.icon, origin) ?? space.icon;
    if (space.banner) space.banner = resolveAssetUrl(space.banner, origin) ?? space.banner;
    for (const member of space.members ?? []) {
      if (member.user) normalizeUserAssets(member.user, origin);
    }
  }
}

function populateReadySpaces(origin: string, event: ReadyEvent): void {
  const isHome = origin === '';
  const { populateFromReady } = useSpaceStore.getState();
  populateFromReady(origin, event.spaces, event.folders, event.dmChannels, event.spaceLayout, event.layoutUpdatedAt);

  // Cache authoritative identity for this origin (federation-safe)
  if (!isHome) {
    setMyUserIdForOrigin(origin, event.user.id);
  }
}

function syncReadyIdentity(origin: string, event: ReadyEvent): void {
  const isHome = origin === '';
  // The user's own chosen status (utils/selfStatus.ts): take it from this
  // socket when it is the owner's report (the true home, for a session on
  // a replicated row), and re-send it to this remote when this session owns
  // the choice and the remote account is the same federated identity.
  {
    const authUser = useAuthStore.getState().user;
    const report = ownStatusReport(authUser, { origin, isHome }, { userId: event.user.id, status: event.user.status });
    if (report) useAuthStore.getState().applyOwnStatus(report);
    if (!isHome) {
      const status = statusToAssertOnRemote(authUser, event.user, window.location.host);
      if (status) wsSend({ type: 'presence_update', status }, origin);
    }
  }

  // Mark remote instance as connected in instanceStore
  if (!isHome) {
    import('../stores/instanceStore').then(({ useInstanceStore }) => {
      useInstanceStore.getState().setInstanceStatus(origin, 'connected');
    });
  }
}

function reloadReadySpace(origin: string, event: ReadyEvent, currentSpaceId: string | null): void {
  const isHome = origin === '';
  const { loadSpaceDetail } = useSpaceStore.getState();
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
}

function resetReadyMessages(origin: string, event: ReadyEvent): void {
  const isHome = origin === '';
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

function hydrateReadyReadStates(origin: string, event: ReadyEvent): void {
  useChannelActivityStore.getState().hydrate(origin, { counts: event.unreadCounts, supportsPoke: event.supportsPoke });
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
}

function hydrateReadyVoicePresence(origin: string, event: ReadyEvent): void {
  const { clearVoiceUsersForOrigin, setVoiceUsers, setVoiceChannelElapsedSeconds } = useVoiceStore.getState();
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
}

function hydrateReadyActivities(origin: string, event: ReadyEvent): void {
  const isHome = origin === '';
  // Activity data from the ready payload: this origin's full snapshot,
  // replacing whatever it reported before the reconnect.
  const olderServerRows = readyRowIndex(event);
  useActivityStore.getState().setOriginRows(origin, olderServerRows);
  if (event.userActivities) {
    useActivityStore.getState().initActivities(readyActivityEntries(event), origin, olderServerRows);
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
    }).catch(() => { });
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
}

function restrictionsOutsideOrigin(restrictions: Set<string>, originSpaceIds: Set<string>): Set<string> {
  return new Set([...restrictions].filter(key => !originSpaceIds.has(key.split(':')[0]!)));
}

function hydrateReadyVoiceRestrictions(origin: string, event: ReadyEvent): void {
  const state = useVoiceStore.getState();
  if (event.voiceUserStates) {
    for (const [uid, status] of Object.entries(event.voiceUserStates)) {
      state.setVoiceUserStatus(uid, status.isMuted, status.isDeafened, status.isCameraOn, status.isScreenSharing);
    }
  }
  const originSpaceIds = new Set(useSpaceStore.getState().spaces.filter(s => s._instanceOrigin === origin).map(s => s.id));
  // Rebuild restrictions only for the reconnecting origin, then publish atomically.
  const nextSpaceMuted = restrictionsOutsideOrigin(state.spaceMutedUserIds, originSpaceIds);
  const nextSpaceDeafened = restrictionsOutsideOrigin(state.spaceDeafenedUserIds, originSpaceIds);
  const nextPermissionMuted = restrictionsOutsideOrigin(state.permissionMutedUserIds, originSpaceIds);
  if (event.spaceVoiceStates) {
    for (const [uid, restriction] of Object.entries(event.spaceVoiceStates as Record<string, { spaceMuted: boolean; spaceDeafened: boolean; permissionMuted?: boolean }>)) {
      if (restriction.spaceMuted) nextSpaceMuted.add(uid);
      if (restriction.spaceDeafened) nextSpaceDeafened.add(uid);
      if (restriction.permissionMuted) nextPermissionMuted.add(uid);
    }
  }
  // Server enforcement never overwrites the user's own local mute/deafen intent.
  useVoiceStore.setState({ spaceMutedUserIds: nextSpaceMuted, spaceDeafenedUserIds: nextSpaceDeafened, permissionMutedUserIds: nextPermissionMuted });
}

function reassertReadySpaceVoice(origin: string, event: ReadyEvent): void {
  const { currentVoiceChannelId, voiceConnectionStatus } = useVoiceStore.getState();
  if (!currentVoiceChannelId || getChannelOrigin(currentVoiceChannelId) !== origin) return;
  if (event.voiceStates?.[currentVoiceChannelId]?.includes(event.user.id)) return;
  const room = getActiveRoom();
  const recoverable = voiceConnectionStatus === 'connecting' || voiceConnectionStatus === 'reconnecting'
    || (room != null && [LiveKitConnectionState.Connected, LiveKitConnectionState.Connecting, LiveKitConnectionState.Reconnecting].includes(room.state));
  if (!recoverable) return;
  // A ready snapshot can precede registration on the new socket. Keep LiveKit's
  // reconnect machinery and local intent intact, and reassert the session.
  wsSend({ type: 'voice_join', channelId: currentVoiceChannelId }, origin);
  broadcastVoiceStatus(origin);
}

function reconcileReadyVoiceSession(origin: string, event: ReadyEvent): void {
  reassertReadySpaceVoice(origin, event);
  // Active DM calls use voice_status, not voice_join, to bind a replacement socket.
  const state = useVoiceStore.getState();
  if (state.activeDmCall && (state.callOrigin || getChannelOrigin(state.activeDmCall.dmChannelId)) === origin) {
    broadcastVoiceStatus(origin);
  }
}

function restoreRingingCall(call: ActiveCallInfo, event: ReadyEvent): void {
  if (call.state !== 'ringing' || call.callerId === event.user.id) return;
  const { setIncomingCall, setFederatedCallData, setFederatedCallId } = useVoiceStore.getState();
  const dmChannel = event.dmChannels?.find(d => d.id === call.dmChannelId);
  const caller = dmChannel?.members?.find(m => m.id === call.callerId);
  setIncomingCall({
    dmChannelId: call.dmChannelId, callerId: call.callerId,
    callerName: caller?.displayName || caller?.username || call.callerId
  });
  if (call.livekitUrl && call.livekitToken) setFederatedCallData(call.livekitToken, call.livekitUrl);
  if (call.federatedCallId) setFederatedCallId(call.federatedCallId);
}

function restoreReadyCalls(origin: string, event: ReadyEvent): void {
  const { activeDmCall, incomingCall, setActiveDmCall, setIncomingCall, disconnectFn } = useVoiceStore.getState();
  if (!event.activeCalls?.length) {
    if (activeDmCall) {
      setActiveDmCall(null);
      disconnectFn?.();
    }
    if (incomingCall) setIncomingCall(null);
    return;
  }
  for (const call of event.activeCalls) {
    const participant = call.participants.includes(event.user.id) || !!call.livekitToken;
    if (call.state === 'active' && participant) {
      // Clear stale ringing, but do not auto-connect after refresh. Preserve the
      // server's ordering: an active participation ends this recovery pass.
      setIncomingCall(null);
      return;
    }
    restoreRingingCall(call, event);
  }
}

function hydrateReadySocial(origin: string, event: ReadyEvent): void {
  const isHome = origin === '';
  // Load social data so profile modals show correct friendship state.
  // Runs on each ready (home + remote) — loadFriends/loadRequests fan out
  // across all connected instances and replace the arrays (idempotent).
  {
    const { loadFriends, loadRequests } = useSocialStore.getState();
    loadFriends();
    loadRequests();
  }

  if (!isHome) return;
  hydrateReadyPeerOrigins(event);
  if (event.pendingApprovalCount && event.pendingApprovalCount > 0) {
    const count = event.pendingApprovalCount;
    useUIStore.getState().addToast(
      `You have ${count} pending peering request${count === 1 ? '' : 's'}`,
      'info',
      5000,
    );
  }
}

function hydrateReadyPeerOrigins(event: ReadyEvent): void {
  rejectedPeerOrigins.clear();
  if (Array.isArray(event.rejectedPeerOrigins)) {
    for (const origin of event.rejectedPeerOrigins) rejectedPeerOrigins.add(origin);
  }
  awaitingApprovalPeerOrigins.clear();
  if (Array.isArray(event.awaitingApprovalPeerOrigins)) {
    for (const origin of event.awaitingApprovalPeerOrigins) awaitingApprovalPeerOrigins.add(origin);
  }
  // These origins are also the allowlist for incoming remote DM events.
  activePeerOrigins.clear();
  if (Array.isArray(event.activePeerOrigins)) {
    for (const origin of event.activePeerOrigins) activePeerOrigins.add(origin);
  }
}
