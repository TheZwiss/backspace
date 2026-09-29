import { useAuthStore } from '../stores/authStore';
import { getMyUserIdForOrigin } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { broadcastDeafenViaLiveKit, broadcastVoiceStatus } from '../utils/voice';
import { applySpaceVoiceState } from '../utils/voiceStateSync';
import { getActiveRoom } from './useLiveKit';
import type { WebSocketEventHandlers } from './webSocketEvents';

export const voiceEvents = {
  voice_state_update: (origin, event) => {
    const { addVoiceUser, removeVoiceUser, setVoiceChannelElapsedSeconds, clearVoiceUserStatus } = useVoiceStore.getState();
    if (event.action === 'join') {
      addVoiceUser(event.channelId, event.userId);
      if (event.channelElapsedSeconds !== undefined) {
        setVoiceChannelElapsedSeconds(event.channelId, event.channelElapsedSeconds);
      }
    } else {
      removeVoiceUser(event.channelId, event.userId);
      clearVoiceUserStatus(event.userId);
    }
  },
  voice_status_update: (origin, event) => {
    const { setVoiceUserStatus } = useVoiceStore.getState();
    setVoiceUserStatus(event.userId, event.isMuted, event.isDeafened, event.isCameraOn, event.isScreenSharing);
  },
  space_voice_state: (origin, event) => {
    // A space the user just joined mid-session — bootstrap its current voice
    // presence (occupants, statuses, space/permission mutes). The `ready`
    // payload only carries this at connect time, so without it the new
    // member's channel sidebar shows empty voice channels until a reload.
    // Scoped to event.spaceId; never disturbs other spaces' live voice state.
    applySpaceVoiceState(event);
  },
  voice_space_muted: (origin, event) => {
    const isHome = origin === '';
    const { setSpaceMutedUser } = useVoiceStore.getState();
    setSpaceMutedUser(event.spaceId, event.userId, event.muted);
    // Broadcast effective state if this targets the current user
    const myMuteId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
    if (event.userId === myMuteId) broadcastVoiceStatus();
  },
  voice_permission_muted: (origin, event) => {
    const isHome = origin === '';
    const { setPermissionMutedUser } = useVoiceStore.getState();
    setPermissionMutedUser(event.spaceId, event.userId, event.muted);
    const myPermMuteId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
    if (event.userId === myPermMuteId) broadcastVoiceStatus();
  },
  voice_space_deafened: (origin, event) => {
    const isHome = origin === '';
    const { setSpaceDeafenedUser } = useVoiceStore.getState();
    setSpaceDeafenedUser(event.spaceId, event.userId, event.deafened);
    // Broadcast effective state if this targets the current user
    const myDeafenId = isHome ? useAuthStore.getState().user?.id : getMyUserIdForOrigin(origin);
    if (event.userId === myDeafenId) {
      broadcastVoiceStatus();
      broadcastDeafenViaLiveKit();
    }
  },
  voice_moved: (origin, event) => {
    const isHome = origin === '';
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
  },
  voice_disconnected: (origin, event) => {
    const isHome = origin === '';
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
  },
} satisfies WebSocketEventHandlers;
