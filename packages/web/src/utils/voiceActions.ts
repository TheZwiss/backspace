import type { VideoCaptureOptions } from 'livekit-client';
import { useVoiceStore, type ActiveDmCall } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { getActiveRoom } from '../hooks/useLiveKit';
import { wsSend } from '../hooks/useWebSocket';
import { getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { broadcastVoiceStatus, broadcastDeafenViaLiveKit, preArmMicrophone } from './voice';
import { dmCallOrigin, dmCallRoomKey, sendDmCallEnd } from './dmCall';
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
 * The space mute and deafen a moderator holds on the user in the voice
 * channel they are in. Both false outside a voice channel (a DM call).
 */
export function getSpaceEnforcementState(): { isSpaceMuted: boolean; isSpaceDeafened: boolean } {
  const { currentVoiceChannelId, spaceMutedUserIds, spaceDeafenedUserIds } = useVoiceStore.getState();
  if (!currentVoiceChannelId) return { isSpaceMuted: false, isSpaceDeafened: false };
  const myId = getMyUserIdForOrigin(getChannelOrigin(currentVoiceChannelId));
  const spaceId = useSpaceStore.getState().channelToSpaceMap.get(currentVoiceChannelId);
  const spaceKey = spaceId && myId ? `${spaceId}:${myId}` : '';
  return {
    isSpaceMuted: spaceMutedUserIds.has(spaceKey),
    isSpaceDeafened: spaceDeafenedUserIds.has(spaceKey),
  };
}

/**
 * Toggle mute from a control that does not track the space restrictions
 * itself (the mobile call screens, the keybinds): the same path as the
 * desktop control bar, broadcast included.
 */
export function toggleMuteFromControl(): void {
  const { isSpaceMuted, isSpaceDeafened } = getSpaceEnforcementState();
  handleMuteAction(isSpaceMuted, isSpaceDeafened);
}

/** Toggle deafen from a control that does not track the space restrictions itself. */
export function toggleDeafenFromControl(): void {
  handleDeafenAction(getSpaceEnforcementState().isSpaceDeafened);
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

/** What a call button asks for besides the call itself. */
export interface DmCallOptions {
  /** A video call: the camera goes on once the call has connected. */
  withCamera?: boolean;
}

/**
 * Ring the other members of `dmChannelId`. Routed to the instance that serves
 * the DM channel (`getChannelOrigin`). Returns false, sending nothing, when
 * `canStartDmCall` refuses. The microphone is armed here, inside the tap, as
 * `joinVoiceChannel` does (`preArmMicrophone`).
 */
export function startDmCall(dmChannelId: string, options: DmCallOptions = {}): boolean {
  const voice = useVoiceStore.getState();
  if (!canStartDmCall(voice)) return false;
  preArmMicrophone();
  voice.setOutgoingCall({ dmChannelId, withCamera: options.withCamera === true });
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
 * Connect LiveKit to the call the client just entered, within the click (iOS
 * needs the gesture for audio), and turn the camera on once connected when
 * the call was asked for with it.
 */
function connectToDmCall(call: ActiveDmCall, withCamera: boolean): void {
  const { connectFn } = useVoiceStore.getState();
  if (!connectFn) return;
  const roomKey = dmCallRoomKey(call);
  connectFn(roomKey, true)
    .then(() => {
      if (withCamera) return turnCameraOnInDmCall(roomKey);
      return undefined;
    })
    .catch((err: unknown) => {
      console.error('[voiceActions] DM call connect failed:', err);
    });
}

/**
 * Join the call already running in `dmChannelId`, the same way accepting its
 * ring does: the call becomes active here at once and LiveKit connects within
 * the click. Returns false, sending nothing, when `canStartDmCall` refuses.
 */
export function joinDmCall(dmChannelId: string, options: DmCallOptions = {}): boolean {
  const voice = useVoiceStore.getState();
  if (!canStartDmCall(voice)) return false;
  preArmMicrophone();
  // Joined through the DM's own instance: the call is named by the DM's id
  // and its hang-up goes there.
  const call: ActiveDmCall = { dmChannelId, federatedCallId: null, callOrigin: null, livekit: null };
  voice.setActiveDmCall(call);
  wsSend({ type: 'dm_call_accept', dmChannelId }, getChannelOrigin(dmChannelId));
  connectToDmCall(call, options.withCamera === true);
  return true;
}

/**
 * Answer the call ringing in. The call becomes active at once, without
 * waiting for `dm_call_accepted` (that event races with the connect's async
 * AudioContext resume), and keeps the ids and the origin the ring came with,
 * so the hang-up goes where the ring came from. The microphone is armed and
 * LiveKit connects within the tap. Returns false when nothing rings.
 */
export function acceptIncomingDmCall(): boolean {
  const voice = useVoiceStore.getState();
  const incoming = voice.incomingCall;
  if (!incoming) return false;
  preArmMicrophone();
  const call: ActiveDmCall = incoming.dmChannelId !== null
    ? { dmChannelId: incoming.dmChannelId, federatedCallId: incoming.federatedCallId, callOrigin: incoming.callOrigin, livekit: incoming.livekit }
    : { dmChannelId: null, federatedCallId: incoming.federatedCallId, callOrigin: incoming.callOrigin, livekit: incoming.livekit };
  voice.setIncomingCall(null);
  voice.setActiveDmCall(call);
  wsSend({ type: 'dm_call_accept', dmChannelId: call.dmChannelId, federatedCallId: call.federatedCallId }, dmCallOrigin(call));
  connectToDmCall(call, false);
  return true;
}

/**
 * Turn the camera on in the DM call `roomKey` names, once it is connected.
 * Does nothing when the client has left that call by then, or the camera is
 * already on.
 */
export async function turnCameraOnInDmCall(roomKey: string): Promise<void> {
  const { activeDmCall, isCameraOn } = useVoiceStore.getState();
  if (!activeDmCall || dmCallRoomKey(activeDmCall) !== roomKey || isCameraOn) return;
  if (!getActiveRoom()) return;
  await handleCameraAction();
}

/**
 * Stop ringing `dmChannelId` before anyone answered. A call this client
 * placed is hosted on the DM's own instance, so the end goes there. Returns
 * false, sending nothing, when the outgoing call belongs to another DM or
 * there is none.
 */
export function cancelOutgoingDmCall(dmChannelId: string): boolean {
  const voice = useVoiceStore.getState();
  if (voice.outgoingCall?.dmChannelId !== dmChannelId) return false;
  voice.setOutgoingCall(null);
  sendDmCallEnd({ dmChannelId, federatedCallId: null, callOrigin: null });
  return true;
}

/**
 * Connect again to the voice the client kept after LiveKit gave up
 * reconnecting: the DM call, or the voice channel. The Retry action of the
 * sidebar and the mobile mini bar.
 */
export function reconnectVoice(): void {
  const { connectFn, activeDmCall, currentVoiceChannelId } = useVoiceStore.getState();
  if (!connectFn) return;
  if (activeDmCall) void connectFn(dmCallRoomKey(activeDmCall), true);
  else if (currentVoiceChannelId) void connectFn(currentVoiceChannelId, false);
}

/**
 * Disconnect from voice. Handles DM call teardown and fullscreen exit.
 */
export function handleDisconnectAction(): void {
  const voice = useVoiceStore.getState();
  const { activeDmCall, currentVoiceChannelId, disconnectFn } = voice;

  if (activeDmCall) {
    sendDmCallEnd(activeDmCall);
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
