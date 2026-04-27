import type { VideoCaptureOptions } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { getActiveRoom } from '../hooks/useLiveKit';
import { wsSend } from '../hooks/useWebSocket';
import { getChannelOrigin } from '../stores/spaceStore';
import { broadcastVoiceStatus, broadcastDeafenViaLiveKit } from './voice';
import { CAMERA_PRESET, startScreenShare, stopScreenShare } from './screenShare';

/**
 * One-shot flag used to distinguish user-initiated camera-off from unexpected
 * track-end events (hardware unplug, OS permission revoke). Set right before
 * `setCameraEnabled(false)` in any deliberate disable path; consumed-and-cleared
 * by the camera-track `ended` handler in useLiveKit. Module-level by design:
 * never persisted, never on the store, single producer + single consumer.
 */
let _intentionalCameraOff = false;

export function markIntentionalCameraOff(): void {
  _intentionalCameraOff = true;
}

export function consumeIntentionalCameraOff(): boolean {
  const v = _intentionalCameraOff;
  _intentionalCameraOff = false;
  return v;
}

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
 * Toggle camera. Requires LiveKit room. Sole canonical camera-toggle path —
 * the voice-bar button, mobile button, and keybind all funnel through here.
 */
export async function handleCameraAction(): Promise<void> {
  const room = getActiveRoom();
  if (!room) return;
  const isCameraOn = useVoiceStore.getState().isCameraOn;
  try {
    const willEnable = !isCameraOn;
    if (willEnable) {
      const cameraDeviceId = useVoiceStore.getState().cameraDeviceId;
      const captureOpts: VideoCaptureOptions = {
        resolution: CAMERA_PRESET.resolution,
        frameRate: CAMERA_PRESET.encoding.maxFramerate,
      };
      if (cameraDeviceId) captureOpts.deviceId = cameraDeviceId;
      await room.localParticipant.setCameraEnabled(
        true,
        captureOpts,
        {
          videoCodec: CAMERA_PRESET.codec,
          videoEncoding: CAMERA_PRESET.encoding,
          simulcast: true,
        }
      );
    } else {
      // Mark this disable as intentional so the track-`ended` handler skips
      // its unplug/permission-revoke probe + toast.
      markIntentionalCameraOff();
      try {
        await room.localParticipant.setCameraEnabled(false);
      } catch (err) {
        // Disable rejected — consume the flag so it doesn't poison the
        // next genuine unplug. Re-throw to the outer catch for logging.
        consumeIntentionalCameraOff();
        throw err;
      }
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
    const origin = voice.callOrigin || getChannelOrigin(activeDmCall.dmChannelId);
    wsSend(
      { type: 'dm_call_end', dmChannelId: activeDmCall.dmChannelId, federatedCallId: voice.federatedCallId },
      origin
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
