import { useEffect, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore, isDmChannel, getChannelOrigin, getMyUserIdForOrigin } from '../../stores/spaceStore';
import { AudioManager } from '../../audio/AudioManager';
import { shouldPlayMessageSound } from '../../utils/notificationFilters';

/** Compute the effective sound effect gain: base volume (0.8) scaled by the user's SFX slider (0–200). */
function getSfxVolume(): number {
  return 0.8 * (useVoiceStore.getState().soundEffectVolume / 100);
}

/**
 * Replicates the `useLiveKit` effective-mute formula on demand. Returns whether
 * the local user is currently muted/deafened by ANY mechanism (self toggle,
 * moderator space-mute, or permission-mute).
 */
function computeEffectiveSelfState(state: ReturnType<typeof useVoiceStore.getState>): {
  muted: boolean;
  deafened: boolean;
} {
  const cvId = state.currentVoiceChannelId;
  if (!cvId) return { muted: state.isMuted, deafened: state.isDeafened };
  const origin = getChannelOrigin(cvId);
  const myId = getMyUserIdForOrigin(origin);
  const spaceId = useSpaceStore.getState().channelToSpaceMap.get(cvId);
  const key = spaceId && myId ? `${spaceId}:${myId}` : '';
  const muted =
    state.isMuted ||
    state.spaceMutedUserIds.has(key) ||
    state.permissionMutedUserIds.has(key);
  const deafened = state.isDeafened || state.spaceDeafenedUserIds.has(key);
  return { muted, deafened };
}

export function SoundController() {
  const audioManager = AudioManager.getInstance();
  const currentUser = useAuthStore((s) => s.user);
  // Federation-aware self-check: in federated calls, the participant userId
  // can flip between localSnowflake (when activeDmCall resolves identity) and
  // homeUserId (when activeDmCall is cleared during disconnect). We must
  // recognize BOTH as "self" to prevent phantom join/leave sounds.
  const myIds = new Set<string>();
  if (currentUser?.id) myIds.add(currentUser.id);
  if (currentUser?.homeUserId) myIds.add(currentUser.homeUserId);
  const isSelf = (id: string) => myIds.has(id);

  const isInitialMount = useRef(true);
  const initialState = useVoiceStore.getState();
  const initialEff = computeEffectiveSelfState(initialState);

  // All previous-sample state lives in one ref so the subscriber callback updates atomically.
  const prev = useRef({
    effectiveMuted: initialEff.muted,
    effectiveDeafened: initialEff.deafened,
    isCameraOn: initialState.isCameraOn,
    isLiveKitConnected: initialState.isLiveKitConnected,
    participantIds: new Set(initialState.participants.map((p) => p.userId)),
    screenShareUserIds: new Set(
      initialState.participants.filter((p) => p.isScreenSharing).map((p) => p.userId),
    ),
    selfWatchers: new Set<string>(),
  });

  const incomingCallLoop = useRef<AudioBufferSourceNode | null>(null);
  const incomingCallLoading = useRef(false);
  const outgoingCallLoop = useRef<AudioBufferSourceNode | null>(null);
  const outgoingCallLoading = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      isInitialMount.current = false;
    }, 1000);

    const unsubscribeVoice = useVoiceStore.subscribe((state) => {
      if (isInitialMount.current) return;

      const sfxOpts = { volume: getSfxVolume() };

      // -------- Effective mute / deafen --------
      // Only play on transitions where BOTH prev and current samples were taken
      // while LK-connected. On the connect/disconnect boundary we snapshot the
      // current effective state without firing.
      const eff = computeEffectiveSelfState(state);
      if (state.isLiveKitConnected && prev.current.isLiveKitConnected) {
        if (eff.muted !== prev.current.effectiveMuted) {
          audioManager.playSound(eff.muted ? 'mute' : 'unmute', sfxOpts);
        }
        if (eff.deafened !== prev.current.effectiveDeafened) {
          audioManager.playSound(eff.deafened ? 'deafen' : 'undeafen', sfxOpts);
        }
      }
      prev.current.effectiveMuted = eff.muted;
      prev.current.effectiveDeafened = eff.deafened;

      // -------- Camera Toggle (self) --------
      if (state.isCameraOn !== prev.current.isCameraOn) {
        audioManager.playSound(state.isCameraOn ? 'camera_on' : 'camera_off', sfxOpts);
        prev.current.isCameraOn = state.isCameraOn;
      }

      // -------- Self connect / disconnect --------
      const justDisconnected = prev.current.isLiveKitConnected && !state.isLiveKitConnected;
      const justConnected = !prev.current.isLiveKitConnected && state.isLiveKitConnected;

      if (justDisconnected) {
        audioManager.playSound('disconnect', sfxOpts);
      }
      if (justConnected) {
        audioManager.playSound('user_join', sfxOpts);
      }
      prev.current.isLiveKitConnected = state.isLiveKitConnected;

      // -------- Participant set diff --------
      const currentParticipantIds = new Set(state.participants.map((p) => p.userId));
      const currentScreenShareUserIds = new Set(
        state.participants.filter((p) => p.isScreenSharing).map((p) => p.userId),
      );

      const myStreamerId = currentUser?.id;
      const selfIsSharing = myStreamerId ? currentScreenShareUserIds.has(myStreamerId) : false;
      const selfStreamJustStarted =
        !!myStreamerId &&
        currentScreenShareUserIds.has(myStreamerId) &&
        !prev.current.screenShareUserIds.has(myStreamerId);
      const selfStreamJustEnded =
        !!myStreamerId &&
        !currentScreenShareUserIds.has(myStreamerId) &&
        prev.current.screenShareUserIds.has(myStreamerId);

      // Suppress join/leave + stream sounds on the connect tick. On
      // justConnected, prev.participantIds is the empty/initial set, so the
      // naive diff would fire user_join (and possibly stream_started) once per
      // pre-existing remote participant. Snapshot baseline only; sounds come
      // from real future transitions.
      if (state.isLiveKitConnected && !justDisconnected && !justConnected) {
        // user_join (others)
        state.participants.forEach((p) => {
          if (!prev.current.participantIds.has(p.userId) && !isSelf(p.userId)) {
            audioManager.playSound('user_join', sfxOpts);
          }
        });
        // user_leave (others)
        prev.current.participantIds.forEach((userId) => {
          if (!currentParticipantIds.has(userId) && !isSelf(userId)) {
            audioManager.playSound('user_leave', sfxOpts);
          }
        });
        // stream_started — ANY participant (incl. self), audible to all
        state.participants.forEach((p) => {
          if (p.isScreenSharing && !prev.current.screenShareUserIds.has(p.userId)) {
            audioManager.playSound('stream_started', sfxOpts);
          }
        });
        // stream_ended — ANY participant, audible to all
        prev.current.screenShareUserIds.forEach((userId) => {
          if (!currentScreenShareUserIds.has(userId)) {
            audioManager.playSound('stream_ended', sfxOpts);
          }
        });
      }

      prev.current.participantIds = currentParticipantIds;
      prev.current.screenShareUserIds = currentScreenShareUserIds;

      // -------- Viewer tracking — streamer-side only (§3.2) --------
      // The full diff is gated on `selfIsSharing`. When self isn't sharing,
      // both prev and current are forced to ∅ — no sounds fire even if a late
      // ping mutates the store. On both stream-start and stream-end transitions
      // for self, eagerly call clearStreamWatchers; the gate makes the
      // re-entered subscriber tick silent. This eliminates the race where a
      // late "Stop Watching" ping arriving between a deferred clear's schedule
      // and execution would fire phantom stream_user_joined / left.
      if (myStreamerId && (selfStreamJustStarted || selfStreamJustEnded)) {
        useVoiceStore.getState().clearStreamWatchers(myStreamerId);
      }

      if (myStreamerId && state.isLiveKitConnected && !justDisconnected && selfIsSharing) {
        const live = new Set(state.streamWatchers.get(myStreamerId) ?? []);
        const past = prev.current.selfWatchers;

        live.forEach((identity) => {
          if (!past.has(identity)) audioManager.playSound('stream_user_joined', sfxOpts);
        });
        past.forEach((identity) => {
          if (!live.has(identity)) audioManager.playSound('stream_user_left', sfxOpts);
        });
        prev.current.selfWatchers = live;
      } else {
        prev.current.selfWatchers = new Set();
      }

      // -------- Incoming Call (Ringing) --------
      if (state.incomingCall && !incomingCallLoop.current && !incomingCallLoading.current) {
        incomingCallLoading.current = true;
        audioManager
          .playSound('call_ringing', { loop: true, volume: getSfxVolume() })
          .then((source) => {
            if (!useVoiceStore.getState().incomingCall) {
              source?.stop();
            } else {
              incomingCallLoop.current = source;
            }
            incomingCallLoading.current = false;
          });
      } else if (!state.incomingCall) {
        if (incomingCallLoop.current) {
          incomingCallLoop.current.stop();
          incomingCallLoop.current = null;
        }
        incomingCallLoading.current = false;
      }

      // -------- Outgoing Call (Calling) --------
      if (state.outgoingCall && !outgoingCallLoop.current && !outgoingCallLoading.current) {
        outgoingCallLoading.current = true;
        audioManager
          .playSound('call_calling', { loop: true, volume: getSfxVolume() })
          .then((source) => {
            if (!useVoiceStore.getState().outgoingCall) {
              source?.stop();
            } else {
              outgoingCallLoop.current = source;
            }
            outgoingCallLoading.current = false;
          });
      } else if (!state.outgoingCall) {
        if (outgoingCallLoop.current) {
          outgoingCallLoop.current.stop();
          outgoingCallLoop.current = null;
        }
        outgoingCallLoading.current = false;
      }
    });

    // -------- Chat: message sound (DM + mention default, federation-aware) --------
    const unsubscribeChat = useChatStore.subscribe((state, prevState) => {
      if (isInitialMount.current) return;

      if (state.realtimeMessageEvents.length > prevState.realtimeMessageEvents.length) {
        const newEvents = state.realtimeMessageEvents.slice(prevState.realtimeMessageEvents.length);
        const allChannels = useVoiceStore.getState().messageSoundAllChannels;
        // Use the wrapper-level channelId from RealtimeMessageEvent — set by
        // addRealtimeMessage(channelId, message). It's authoritative for both
        // space and DM messages. Avoids reaching into the heterogeneous Message
        // shape (where DM messages may carry dmChannelId at runtime).
        for (const { channelId, message } of newEvents) {
          if (!channelId) continue;
          const isDm = isDmChannel(channelId);
          if (
            shouldPlayMessageSound({
              authorUserId: message.userId,
              myIds,
              isDmChannel: isDm,
              content: message.content,
              allChannels,
            })
          ) {
            audioManager.playSound('message', { volume: getSfxVolume() });
            break;
          }
        }
      }
    });

    return () => {
      clearTimeout(timer);
      unsubscribeVoice();
      unsubscribeChat();
      if (incomingCallLoop.current) incomingCallLoop.current.stop();
      if (outgoingCallLoop.current) outgoingCallLoop.current.stop();
    };
  }, [audioManager, currentUser?.id, currentUser?.homeUserId]);

  return null;
}
