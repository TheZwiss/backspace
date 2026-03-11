import { useVoiceStore } from '../stores/voiceStore';
import { getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { wsSend } from '../hooks/useWebSocket';

// ---------------------------------------------------------------------------
// Effective-state helpers — single source of truth for broadcasts
// ---------------------------------------------------------------------------

/**
 * Compute effective mute/deafen by merging user intent with server enforcement,
 * then broadcast the effective voice_status over the WebSocket.
 *
 * @param overrideOrigin  Pass explicitly when called from a WS handler that
 *                        knows the origin. Omit to derive from currentVoiceChannelId.
 */
export function broadcastVoiceStatus(overrideOrigin?: string): void {
  const vs = useVoiceStore.getState();
  const { isMuted, isDeafened, isCameraOn, isScreenSharing, currentVoiceChannelId, spaceMutedUserIds, spaceDeafenedUserIds } = vs;
  if (!currentVoiceChannelId) return;

  const origin = overrideOrigin ?? getChannelOrigin(currentVoiceChannelId);
  const myId = getMyUserIdForOrigin(origin);
  const spaceId = useSpaceStore.getState().channelToSpaceMap.get(currentVoiceChannelId);
  const spaceKey = (spaceId && myId) ? `${spaceId}:${myId}` : '';

  const effectiveMuted = isMuted || spaceMutedUserIds.has(spaceKey);
  const effectiveDeafened = isDeafened || spaceDeafenedUserIds.has(spaceKey);

  wsSend({ type: 'voice_status', isMuted: effectiveMuted, isDeafened: effectiveDeafened, isCameraOn, isScreenSharing }, origin);
}

/**
 * Broadcast the effective deafen state to in-room participants via the
 * LiveKit data channel. Dynamic-imports getActiveRoom to avoid circular deps.
 */
export function broadcastDeafenViaLiveKit(): void {
  const vs = useVoiceStore.getState();
  const { isDeafened, currentVoiceChannelId, spaceDeafenedUserIds } = vs;
  if (!currentVoiceChannelId) return;

  const origin = getChannelOrigin(currentVoiceChannelId);
  const myId = getMyUserIdForOrigin(origin);
  const spaceId = useSpaceStore.getState().channelToSpaceMap.get(currentVoiceChannelId);
  const spaceKey = (spaceId && myId) ? `${spaceId}:${myId}` : '';
  const effectiveDeafened = isDeafened || spaceDeafenedUserIds.has(spaceKey);

  import('../hooks/useLiveKit').then(({ getActiveRoom }) => {
    const room = getActiveRoom();
    if (room) {
      const encoder = new TextEncoder();
      room.localParticipant.publishData(
        encoder.encode(JSON.stringify({ type: 'deafen', deafened: effectiveDeafened })),
        { reliable: true }
      ).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------
// Voice channel join
// ---------------------------------------------------------------------------

/**
 * Centralized voice channel join that handles cross-instance cleanup.
 * When switching from a channel on Instance A to one on Instance B,
 * this sends an explicit voice_leave to Instance A first so it
 * broadcasts a leave event and the client cleans up stale voice state.
 */
export function joinVoiceChannel(channelId: string): void {
  const { currentVoiceChannelId, setCurrentVoiceChannel, addVoiceUser, removeVoiceUser } = useVoiceStore.getState();
  if (currentVoiceChannelId === channelId) return;

  // Leave old instance if switching cross-origin
  if (currentVoiceChannelId) {
    const oldOrigin = getChannelOrigin(currentVoiceChannelId);
    const newOrigin = getChannelOrigin(channelId);
    if (oldOrigin !== newOrigin) {
      wsSend({ type: 'voice_leave' }, oldOrigin);
    }
    // Optimistic: immediately remove self from old channel (using origin-aware ID)
    const myOldId = getMyUserIdForOrigin(oldOrigin);
    if (myOldId) removeVoiceUser(currentVoiceChannelId, myOldId);
  }

  setCurrentVoiceChannel(channelId);
  // voice_join is now sent by useLiveKit after successful LiveKit connection
  // Optimistic: immediately show self in new channel (using origin-aware ID)
  const myNewId = getMyUserIdForOrigin(getChannelOrigin(channelId));
  if (myNewId) addVoiceUser(channelId, myNewId);
}
