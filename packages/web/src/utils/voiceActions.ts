import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { getActiveRoom } from '../hooks/useLiveKit';
import { wsSend } from '../hooks/useWebSocket';
import { getChannelOrigin } from '../stores/spaceStore';
import { broadcastVoiceStatus, broadcastDeafenViaLiveKit } from './voice';
import { CAMERA_PRESET, startScreenShare, stopScreenShare } from './screenShare';

/**
 * Toggle mute. Respects space-mute/deafen guards.
 * Extracted from VoiceControlBar so keybinds and buttons share the same logic.
 */
export function handleMuteAction(isSpaceMuted: boolean, isSpaceDeafened: boolean): void {
  if (isSpaceMuted || isSpaceDeafened) return;
  const wasDeafened = useVoiceStore.getState().isDeafened;
  useVoiceStore.getState().toggleMic();
  broadcastVoiceStatus();
  if (wasDeafened && !useVoiceStore.getState().isDeafened) {
    broadcastDeafenViaLiveKit();
  }
}

/**
 * Toggle deafen. Respects space-deafen guard.
 */
export function handleDeafenAction(isSpaceDeafened: boolean): void {
  if (isSpaceDeafened) return;
  useVoiceStore.getState().toggleDeafen();
  broadcastVoiceStatus();
  broadcastDeafenViaLiveKit();
}

/**
 * Toggle camera. Requires LiveKit room.
 */
export async function handleCameraAction(): Promise<void> {
  const room = getActiveRoom();
  if (!room) return;
  const isCameraOn = useVoiceStore.getState().isCameraOn;
  try {
    const willEnable = !isCameraOn;
    if (willEnable) {
      await room.localParticipant.setCameraEnabled(true,
        { resolution: CAMERA_PRESET.resolution },
        {
          videoCodec: CAMERA_PRESET.codec,
          videoEncoding: CAMERA_PRESET.encoding,
          simulcast: true,
        }
      );
    } else {
      await room.localParticipant.setCameraEnabled(false);
    }
    useVoiceStore.getState().toggleCamera();
    broadcastVoiceStatus();
  } catch (err) {
    console.error('[voiceActions] Failed to toggle camera:', err);
  }
}

/**
 * Toggle screen share. Requires LiveKit room.
 * Note: startScreenShare/stopScreenShare manage voiceStore.isScreenSharing internally.
 * Do NOT call toggleScreenShare() here — it would double-flip the state.
 */
export async function handleScreenShareAction(): Promise<void> {
  const room = getActiveRoom();
  if (!room) return;
  const isScreenSharing = useVoiceStore.getState().isScreenSharing;
  try {
    if (!isScreenSharing) {
      const started = await startScreenShare(room);
      if (started) broadcastVoiceStatus();
    } else {
      await stopScreenShare(room);
      broadcastVoiceStatus();
    }
  } catch (err) {
    console.error('[voiceActions] Failed to toggle screen share:', err);
  }
}

/**
 * Disconnect from voice. Handles DM call teardown and fullscreen exit.
 */
export function handleDisconnectAction(): void {
  const voice = useVoiceStore.getState();
  const { activeDmCall, currentVoiceChannelId, disconnectFn } = voice;

  if (activeDmCall) {
    wsSend(
      { type: 'dm_call_end', dmChannelId: activeDmCall.dmChannelId },
      getChannelOrigin(activeDmCall.dmChannelId)
    );
    voice.setActiveDmCall(null);
  } else if (currentVoiceChannelId) {
    const origin = getChannelOrigin(currentVoiceChannelId);
    wsSend({ type: 'voice_leave' }, origin);
    voice.leaveVoice();
  }

  // Tear down the LiveKit connection
  if (disconnectFn) disconnectFn();

  // Exit fullscreen if active
  const voiceFullscreen = useUIStore.getState().voiceFullscreen;
  if (voiceFullscreen) {
    useUIStore.getState().setVoiceFullscreen(false);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }
}
