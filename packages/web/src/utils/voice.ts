import { useVoiceStore } from '../stores/voiceStore';
import { getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { wsSend } from '../hooks/useWebSocket';
import { AudioManager } from '../audio/AudioManager';
import { useUIStore } from '../stores/uiStore';

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
  // Optimistic: immediately show self in new channel (using origin-aware ID)
  const myNewId = getMyUserIdForOrigin(getChannelOrigin(channelId));
  if (myNewId) addVoiceUser(channelId, myNewId);

  // Pre-arm the microphone INSIDE the user-gesture context. This must
  // happen before `connectFn` so the call to `setInputDevice` (which is
  // routed through `inputSwitchChain.then(...)` and ends in
  // `getUserMedia`) is invoked while the activation window is still open.
  // Reset the prior denial flag so a re-attempt isn't pre-vetoed by
  // syncMic, and clear AudioManager's cached denial so the next
  // `getUserMedia` actually fires (rather than re-throwing the cached
  // error from a previous denial in this session).
  const voiceState = useVoiceStore.getState();
  voiceState.setMicPermissionDenied(false);
  const audioManager = AudioManager.getInstance();
  audioManager.clearInputDenial();
  // Resume the AudioContext synchronously inside the gesture too — iOS
  // requires `AudioContext.resume()` to be invoked from a user
  // activation. Fire-and-forget; `useLiveKit.connect` also calls this
  // and will await the same context.
  audioManager.resumeContext().catch((err) => {
    console.warn('[voice] AudioContext resume failed:', err);
  });
  // Fire-and-forget. `setInputDevice` is internally serialized via
  // `inputSwitchChain` so the later syncMic call short-circuits to the
  // already-acquired stream rather than re-prompting. On denial we
  // record the flag — syncMic will then skip the publish branch.
  audioManager.setInputDevice(voiceState.inputDeviceId).catch((err: unknown) => {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotAllowedError') {
      useVoiceStore.getState().setMicPermissionDenied(true);
      useUIStore.getState().addToast(
        'Microphone access denied. You joined as a listener — tap "Allow microphone" to grant access.',
        'warning',
      );
    } else if (name === 'NotFoundError') {
      // No mic hardware available. Proceed as listener.
      useVoiceStore.getState().setMicPermissionDenied(true);
      useUIStore.getState().addToast(
        'No microphone detected. You joined as a listener.',
        'info',
      );
    } else {
      console.error('[voice] Mic pre-arm failed:', err);
    }
  });

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
    await audioManager.setInputDevice(inputDeviceId);
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
