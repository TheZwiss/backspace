import type { VideoCaptureOptions } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { getActiveRoom } from '../hooks/useLiveKit';
import { wsSend } from '../hooks/useWebSocket';
import { getChannelOrigin } from '../stores/spaceStore';
import { broadcastVoiceStatus, broadcastDeafenViaLiveKit } from './voice';
import { CAMERA_PRESET, stopScreenShare } from './screenShare';
import { openScreenShareSetup } from '../stores/screenShareSetupStore';

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
 * Screen-share button/keybind action. Idle → opens the setup screen (source +
 * quality, then "Start stream"); live → stops the share. Starting never happens
 * here: every share is staged and published from ScreenShareSetup.
 * Note: stopScreenShare manages voiceStore.isScreenSharing and broadcasts the
 * new voice status itself, so neither is repeated here.
 */
export async function handleScreenShareAction(): Promise<void> {
  const room = getActiveRoom();
  if (!room) return;
  if (!useVoiceStore.getState().isScreenSharing) {
    openScreenShareSetup();
    return;
  }
  try {
    await stopScreenShare(room);
  } catch (err) {
    console.error('[voiceActions] Failed to stop screen share:', err);
  }
}

/**
 * The DM call slots a new call would collide with. A client holds at most one
 * DM call at a time, ringing in either direction or connected; the server
 * keys the ringing room by DM, so starting while any slot is taken would
 * open a second room.
 */
export type DmCallSlots = Pick<ReturnType<typeof useVoiceStore.getState>, 'outgoingCall' | 'incomingCall' | 'activeDmCall'>;

/**
 * Whether a new DM call may be started. The one rule every call button reads,
 * so the desktop and mobile headers cannot drift. Usable directly as a store
 * selector: `useVoiceStore(canStartDmCall)`.
 */
export function canStartDmCall(state: DmCallSlots): boolean {
  return state.outgoingCall === null && state.incomingCall === null && state.activeDmCall === null;
}

/**
 * Ring the other members of `dmChannelId`. Routed to the instance that serves
 * the DM channel (`getChannelOrigin`). Returns false, sending nothing, when
 * `canStartDmCall` refuses.
 */
export function startDmCall(dmChannelId: string): boolean {
  const voice = useVoiceStore.getState();
  if (!canStartDmCall(voice)) return false;
  voice.setOutgoingCall({ dmChannelId });
  wsSend({ type: 'dm_call_start', dmChannelId }, getChannelOrigin(dmChannelId));
  return true;
}

/**
 * Whether `dmChannelId` has a call with someone in it, as the DM's instance
 * reports it through `voice_state_update` and the `ready` voice states. A
 * member who is not in that call joins it rather than starting another
 * (`joinDmCall`). A call that is still ringing has nobody in it yet; starting
 * one there joins it on the server instead.
 */
export function isDmCallRunning(state: Pick<ReturnType<typeof useVoiceStore.getState>, 'voiceUsers'>, dmChannelId: string): boolean {
  return (state.voiceUsers.get(dmChannelId)?.length ?? 0) > 0;
}

/**
 * Join the call already running in `dmChannelId`, the same way accepting its
 * ring does: the call becomes active here at once and LiveKit connects within
 * the click (iOS needs the gesture for audio). Returns false, sending
 * nothing, when `canStartDmCall` refuses.
 */
export function joinDmCall(dmChannelId: string): boolean {
  const voice = useVoiceStore.getState();
  if (!canStartDmCall(voice)) return false;
  // This call is joined through the DM's own instance. Federated call data
  // left by an earlier ring belongs to no call this client holds, and the
  // hang-up must not follow its `callOrigin`.
  voice.clearFederatedCallData();
  voice.setActiveDmCall({ dmChannelId });
  wsSend({ type: 'dm_call_accept', dmChannelId }, getChannelOrigin(dmChannelId));
  if (voice.connectFn) {
    voice.connectFn(dmChannelId, true).catch((err: unknown) => {
      console.error('[voiceActions] DM call join failed:', err);
    });
  }
  return true;
}

/**
 * Stop ringing `dmChannelId` before anyone answered. A federated call is
 * ended where it was created (`callOrigin`, with its `federatedCallId`), a
 * local one on the DM channel's origin. Returns false, sending nothing, when
 * the outgoing call belongs to another DM or there is none.
 */
export function cancelOutgoingDmCall(dmChannelId: string): boolean {
  const voice = useVoiceStore.getState();
  if (voice.outgoingCall?.dmChannelId !== dmChannelId) return false;
  const { federatedCallId, callOrigin } = voice;
  voice.setOutgoingCall(null);
  wsSend({ type: 'dm_call_end', dmChannelId, federatedCallId }, callOrigin || getChannelOrigin(dmChannelId));
  return true;
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
