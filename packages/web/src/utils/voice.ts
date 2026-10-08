import { useVoiceStore } from '../stores/voiceStore';
import { getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { wsSend } from '../hooks/useWebSocket';
import { AudioManager } from '../audio/AudioManager';
import { useUIStore } from '../stores/uiStore';
import i18n from '../i18n';
import { dmCallOrigin, sendDmCallEnd, voiceSessionOrigin } from './dmCall';

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
  const {
    isMuted, isDeafened, isCameraOn, isScreenSharing, currentVoiceChannelId,
    activeDmCall, spaceMutedUserIds, spaceDeafenedUserIds,
  } = vs;
  if (!currentVoiceChannelId && !activeDmCall) return;

  const origin = overrideOrigin ?? voiceSessionOrigin(vs);
  const myId = getMyUserIdForOrigin(origin);
  const spaceId = currentVoiceChannelId
    ? useSpaceStore.getState().channelToSpaceMap.get(currentVoiceChannelId)
    : null;
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

/**
 * Clear the client-side presence of a *space* voice channel when the local user
 * transitions into a DM call.
 *
 * A DM call and a space voice channel are mutually exclusive: the invariant is
 * that a DM call has **no** `currentVoiceChannelId` (only `activeDmCall`). The
 * space→DM transition must therefore drop the space channel's client state, the
 * mirror of `joinVoiceChannel` clearing `activeDmCall` on the DM→space
 * transition.
 *
 * Why this is necessary even though the server already drops us from the space
 * room (`dm_call_start` / `dm_call_accept` → `leaveCurrentRoom` →
 * `broadcastRoomLeave`): `VoiceChannel` renders the occupant list for the
 * channel equal to `currentVoiceChannelId` from the *live LiveKit participants*
 * (its "our channel is the source of truth" branch). If `currentVoiceChannelId`
 * still points at the old space channel, the DM call's participants get mapped
 * onto it and the local user appears to still be sitting in the space channel.
 *
 * When the channel is on another instance than the call goes through, that
 * instance is sent `voice_leave`: nothing else tells it the user left.
 *
 * Clears `currentVoiceChannelId` directly (not via `setCurrentVoiceChannel`,
 * which would also wipe the `activeDmCall` the caller/acceptor just set) and
 * optimistically removes self from the old channel's `voiceUsers` so the
 * sidebar updates immediately, without waiting for the server's leave
 * broadcast.
 */
export function clearSpaceVoiceForDmCall(): void {
  const { currentVoiceChannelId, removeVoiceUser, activeDmCall } = useVoiceStore.getState();
  if (!currentVoiceChannelId) return;

  const origin = getChannelOrigin(currentVoiceChannelId);
  // The instance the call goes through takes the user out of its own voice
  // channel when it sees the call. The channel's instance hears nothing of a
  // call that goes through another one, so it is told here, or it keeps the
  // user in the channel until their socket to it closes.
  if (activeDmCall && dmCallOrigin(activeDmCall) !== origin) wsSend({ type: 'voice_leave' }, origin);
  const myId = getMyUserIdForOrigin(origin);
  if (myId) removeVoiceUser(currentVoiceChannelId, myId);

  useVoiceStore.setState({ currentVoiceChannelId: null });
}

// ---------------------------------------------------------------------------
// Microphone pre-arm
// ---------------------------------------------------------------------------

/**
 * Acquire the microphone inside the user's tap, before anything awaits.
 * Every way into voice calls it first: joining a voice channel, starting or
 * joining a DM call, accepting a ring.
 *
 * iOS Safari surfaces the microphone prompt only when `getUserMedia` runs
 * inside an active user gesture, and the installed web app is strictest. The
 * connect reaches `useLiveKit`'s `syncMic` many awaits later (token fetch,
 * signalling), past the gesture window, so without this the prompt can fail
 * to appear and the user is in voice without a microphone.
 *
 * Resets the denial flag and AudioManager's cached denial so a new attempt
 * actually prompts. Fire-and-forget: `setInputDevice` is serialized through
 * `inputSwitchChain`, so `syncMic` later reuses the stream acquired here
 * instead of prompting again. A refusal or a missing microphone sets
 * `micPermissionDenied`, and the user is in voice as a listener.
 */
export function preArmMicrophone(): void {
  const voiceState = useVoiceStore.getState();
  voiceState.setMicPermissionDenied(false);
  const audioManager = AudioManager.getInstance();
  audioManager.clearInputDenial();
  // iOS requires `AudioContext.resume()` from a user activation too.
  // `useLiveKit.connect` also calls this and awaits the same context.
  audioManager.resumeContext().catch((err: unknown) => {
    console.warn('[voice] AudioContext resume failed:', err);
  });
  audioManager.setInputDevice(voiceState.inputDeviceId).catch((err: unknown) => {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError') {
      useVoiceStore.getState().setMicPermissionDenied(true);
      useUIStore.getState().addToast(i18n.t('voice:micPrearm.denied'), 'warning');
    } else if (name === 'NotFoundError') {
      // No mic hardware available. Proceed as listener.
      useVoiceStore.getState().setMicPermissionDenied(true);
      useUIStore.getState().addToast(i18n.t('voice:micPrearm.notFound'), 'info');
    } else {
      console.error('[voice] Mic pre-arm failed:', err);
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
 *
 * **iOS user-gesture discipline.** `getUserMedia({audio:…})` is fired
 * synchronously here (before any await crosses the gesture boundary) so
 * iOS Safari surfaces the microphone permission prompt immediately on
 * the user's tap. The previous flow only acquired the mic in the
 * `useLiveKit` `syncMic` effect, which fires AFTER `room.connect()`
 * (token fetch + WS handshake) completes — many awaits past the
 * activation window. iOS PWA standalone is especially strict and would
 * silently never surface the prompt; the user appeared stuck on
 * "Waiting for others to join…" until they locked/unlocked the device,
 * which iOS treats as a fresh activation context that finally allowed
 * the queued prompt to surface.
 *
 * **Denial path.** If the user denies the prompt (NotAllowedError),
 * `voiceStore.micPermissionDenied` is set to true and we proceed with
 * the LiveKit connect anyway. The user appears in the voice channel
 * normally, can hear other participants, but no microphone track is
 * ever published — `useLiveKit.syncMic` skips the publish branch when
 * the flag is set. UI surfaces a "Grant microphone access" affordance
 * (`MobileVoiceFullScreen`, `VoiceControlBar`) that retries
 * `getUserMedia` from a fresh user gesture; on success the flag clears
 * and `useLiveKit.republishMicrophone` is called directly. The flag
 * resets to `false` automatically on `leaveVoice()` /
 * `handleForceDisconnect()` so a rejoin attempts a fresh prompt.
 *
 * @param channelId   The channel to join.
 * @param connectFn   The LiveKit connect function, obtained from
 *                    `useVoiceStore.getState().connectFn`. When provided the
 *                    LiveKit connection is initiated directly within the
 *                    caller's gesture context (required on iOS).
 */
export function joinVoiceChannel(
  channelId: string,
  connectFn?: (channelId: string, isDm?: boolean) => Promise<void>,
): void {
  const {
    currentVoiceChannelId, voiceConnectionStatus,
    setCurrentVoiceChannel, addVoiceUser, removeVoiceUser,
  } = useVoiceStore.getState();
  // Re-selecting the channel we are already live in stays a no-op, but a
  // dropped session deliberately keeps `currentVoiceChannelId` set so the
  // session can be resumed. Without the status check the same click would mean
  // "nothing" instead of "reconnect", and hanging up would be the only way
  // back into the channel the user never meant to leave.
  if (currentVoiceChannelId === channelId && voiceConnectionStatus !== 'disconnected') return;

  const newOrigin = getChannelOrigin(channelId);

  // A DM call held through another instance is left there: the channel's
  // instance takes the user out of a call only when the call goes through
  // it (its voice_join does). `voice_leave` leaves the call the way joining
  // voice there would; a call still ringing is cancelled.
  {
    const { activeDmCall, outgoingCall, setOutgoingCall } = useVoiceStore.getState();
    if (activeDmCall && dmCallOrigin(activeDmCall) !== newOrigin) {
      wsSend({ type: 'voice_leave' }, dmCallOrigin(activeDmCall));
    }
    if (outgoingCall && getChannelOrigin(outgoingCall.dmChannelId) !== newOrigin) {
      sendDmCallEnd({ dmChannelId: outgoingCall.dmChannelId, federatedCallId: null, callOrigin: null });
      setOutgoingCall(null);
    }
  }

  // Leave old instance if switching cross-origin
  if (currentVoiceChannelId) {
    const oldOrigin = getChannelOrigin(currentVoiceChannelId);
    if (oldOrigin !== newOrigin) {
      wsSend({ type: 'voice_leave' }, oldOrigin);
    }
    // Optimistic: immediately remove self from old channel (using origin-aware ID)
    const myOldId = getMyUserIdForOrigin(oldOrigin);
    if (myOldId) removeVoiceUser(currentVoiceChannelId, myOldId);
  }

  setCurrentVoiceChannel(channelId);
  // Optimistic: immediately show self in new channel (using origin-aware ID)
  const myNewId = getMyUserIdForOrigin(newOrigin);
  if (myNewId) addVoiceUser(channelId, myNewId);

  // Pre-arm the microphone INSIDE the user-gesture context, before
  // `connectFn` (see `preArmMicrophone`).
  preArmMicrophone();

  // Direct connection within gesture context
  if (connectFn) {
    connectFn(channelId).catch((err) => {
      console.error('[voice] Connection failed:', err);
      setCurrentVoiceChannel(null);
      if (myNewId) removeVoiceUser(channelId, myNewId);
    });
  }
}

/**
 * Re-attempt microphone permission acquisition after a previous denial.
 * Must be called from a user-gesture handler (button click, etc.) for iOS
 * Safari to actually surface the permission prompt. On success, clears the
 * `micPermissionDenied` flag and the next `useLiveKit` syncMic tick (or an
 * external `republishMicrophone` call) publishes the freshly acquired
 * stream.
 *
 * Returns `true` when the mic was acquired, `false` on any error
 * (NotAllowedError, NotFoundError, etc.).
 */
export async function requestMicPermission(): Promise<boolean> {
  const audioManager = AudioManager.getInstance();
  const inputDeviceId = useVoiceStore.getState().inputDeviceId;
  // Clear AudioManager's cached denial so the next `setInputDevice` call
  // actually fires `getUserMedia` instead of re-throwing the cached error.
  audioManager.clearInputDenial();
  try {
    // Resume context first — iOS may have suspended it during the denied
    // state.
    await audioManager.resumeContext();
    const stream = await audioManager.setInputDevice(inputDeviceId);
    if (!stream) return false;
    useVoiceStore.getState().setMicPermissionDenied(false);
    return true;
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError') {
      useUIStore.getState().addToast(
        'Microphone permission still denied. Open Settings → Safari to grant access.',
        'warning',
      );
    } else if (name === 'NotFoundError') {
      useUIStore.getState().addToast(
        'No microphone detected.',
        'warning',
      );
    } else {
      useUIStore.getState().addToast(
        'Could not access the microphone.',
        'warning',
      );
    }
    return false;
  }
}
