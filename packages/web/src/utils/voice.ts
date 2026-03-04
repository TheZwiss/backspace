import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { getChannelOrigin } from '../stores/serverStore';
import { wsSend } from '../hooks/useWebSocket';

/**
 * Centralized voice channel join that handles cross-instance cleanup.
 * When switching from a channel on Instance A to one on Instance B,
 * this sends an explicit voice_leave to Instance A first so it
 * broadcasts a leave event and the client cleans up stale voice state.
 */
export function joinVoiceChannel(channelId: string): void {
  const { currentVoiceChannelId, setCurrentVoiceChannel, addVoiceUser, removeVoiceUser } = useVoiceStore.getState();
  if (currentVoiceChannelId === channelId) return;

  const myId = useAuthStore.getState().user?.id;

  // Leave old instance if switching cross-origin
  if (currentVoiceChannelId) {
    const oldOrigin = getChannelOrigin(currentVoiceChannelId);
    const newOrigin = getChannelOrigin(channelId);
    if (oldOrigin !== newOrigin) {
      wsSend({ type: 'voice_leave' }, oldOrigin);
    }
    // Optimistic: immediately remove self from old channel
    if (myId) removeVoiceUser(currentVoiceChannelId, myId);
  }

  setCurrentVoiceChannel(channelId);
  // voice_join is now sent by useLiveKit after successful LiveKit connection
  // Optimistic: immediately show self in new channel
  if (myId) addVoiceUser(channelId, myId);
}
