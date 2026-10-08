import { useEffect, useRef } from 'react';
import { isInVoiceRoom, useVoiceStore } from '../../stores/voiceStore';
import { useChatStore, addedRealtimeMessageEvents } from '../../stores/chatStore';
import { selectMyChosenStatus, useAuthStore } from '../../stores/authStore';
import { useSpaceStore, getChannelOrigin, getMyUserIdForOrigin } from '../../stores/spaceStore';
import { homeIdentityOf } from '../../utils/identity';
import { voiceSessionOrigin } from '../../utils/dmCall';
import { AudioManager } from '../../audio/AudioManager';
import { selectVoiceStateSound } from '../../utils/voiceSoundTransitions';
import { getSfxVolume } from '../../utils/sfx';
import { alertsAllowed, messageAlertsUser, playAlertSound } from '../../utils/alerts';
import type { ParticipantInfo } from '../../hooks/useLiveKit';

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

/**
 * Our own share as the participant list shows it. Found by `isLocal`, not by an
 * account id: the local participant is listed under whatever id the room's
 * instance knows us by (another instance's id in a remote space's channel, the
 * DM member's id in a federated call), while the LiveKit identity is the key
 * every viewer's `stream_watch` ping is filed under (`streamWatchKey`).
 */
function localShareOf(participants: readonly ParticipantInfo[]): { identity: string | null; sharing: boolean } {
  const self = participants.find((p) => p.isLocal);
  return { identity: self?.identity ?? null, sharing: self?.isScreenSharing ?? false };
}

export function SoundController() {
  const audioManager = AudioManager.getInstance();
  const currentUser = useAuthStore((s) => s.user);
  // A participant id is either the call's instance's row id or, in a
  // federated call while the DM is not resolved (e.g. during disconnect), the
  // LiveKit identity's home user id. Both name the signed-in user when they
  // are the id that instance gave them or the id of their home identity.
  const isSelf = (id: string): boolean => {
    if (id === getMyUserIdForOrigin(voiceSessionOrigin(useVoiceStore.getState()))) return true;
    const user = useAuthStore.getState().user;
    return !!user && id === homeIdentityOf(user, '')?.userId;
  };

  const isInitialMount = useRef(true);
  const initialState = useVoiceStore.getState();
  const initialEff = computeEffectiveSelfState(initialState);
  const initialSelf = localShareOf(initialState.participants);

  // All previous-sample state lives in one ref so the subscriber callback updates atomically.
  const prev = useRef({
    effectiveMuted: initialEff.muted,
    effectiveDeafened: initialEff.deafened,
    isCameraOn: initialState.isCameraOn,
    /** In the LiveKit room, a reconnect in progress included (`isInVoiceRoom`). */
    inRoom: isInVoiceRoom(initialState),
    participantIds: new Set(initialState.participants.map((p) => p.userId)),
    screenShareUserIds: new Set(
      initialState.participants.filter((p) => p.isScreenSharing).map((p) => p.userId),
    ),
    /** Our own participant's LiveKit identity while listed: the key of our watcher set. */
    selfIdentity: initialSelf.identity,
    selfSharing: initialSelf.sharing,
    selfWatchers: new Set<string>(),
  });

  const incomingCallLoop = useRef<AudioBufferSourceNode | null>(null);
  const incomingCallLoading = useRef(false);
  /** Bumped when a pending ring load is abandoned, so its late result is discarded. */
  const incomingCallAttempt = useRef(0);
  const outgoingCallLoop = useRef<AudioBufferSourceNode | null>(null);
  const outgoingCallLoading = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      isInitialMount.current = false;
    }, 1000);

    // The ring is a state, not an event: it plays exactly while a call is
    // waiting AND incoming-call alerts are allowed (Do Not Disturb, sounds.md).
    // Re-evaluated on every voice tick and on every change of the user's own
    // status, so switching to dnd mid-ring silences it and leaving dnd while the
    // call still rings starts it. The in-app incoming-call card is unaffected.
    const shouldRing = () => !!useVoiceStore.getState().incomingCall && alertsAllowed('incoming_call');
    const syncIncomingRing = () => {
      if (shouldRing()) {
        if (incomingCallLoop.current || incomingCallLoading.current) return;
        const attempt = ++incomingCallAttempt.current;
        incomingCallLoading.current = true;
        playAlertSound('incoming_call', { loop: true })
          .then((source) => {
            if (attempt !== incomingCallAttempt.current) {
              // Abandoned by the stop branch: another load may own the loop now.
              source?.stop();
              return;
            }
            incomingCallLoading.current = false;
            if (!source) return;
            if (shouldRing()) {
              incomingCallLoop.current = source;
            } else {
              source.stop();
            }
          })
          .catch((err: unknown) => {
            if (attempt === incomingCallAttempt.current) incomingCallLoading.current = false;
            console.warn('[SoundController] ringing failed to start', err);
          });
        return;
      }
      if (incomingCallLoop.current) {
        incomingCallLoop.current.stop();
        incomingCallLoop.current = null;
      }
      // Abandon a load still in flight, so a playSound that never settles
      // cannot block every later ring.
      if (incomingCallLoading.current) {
        incomingCallAttempt.current++;
        incomingCallLoading.current = false;
      }
    };

    const unsubscribeVoice = useVoiceStore.subscribe((state) => {
      if (isInitialMount.current) return;

      const sfxOpts = { volume: getSfxVolume() };

      // A reconnect is not a leave: the user is in the room throughout, and
      // only a reconnect that gives up (or a real leave) ends it. While it
      // runs the room's participant list is not to be trusted (a full
      // reconnect drops every remote participant until it is back), so the
      // diffs below keep their baseline and compare against it once the room
      // is connected again.
      const inRoom = isInVoiceRoom(state);
      const reconnecting = inRoom && !state.isLiveKitConnected;

      // -------- Effective mute / deafen --------
      // Only play on transitions where BOTH prev and current samples were taken
      // in the room. On the connect/disconnect boundary we snapshot the
      // current effective state without firing.
      const eff = computeEffectiveSelfState(state);
      if (inRoom && prev.current.inRoom) {
        // Deafen toggles mute as an atomic side effect (see
        // selectVoiceStateSound) — pick the single correct cue so deafening
        // doesn't play the mute sound on top of the deafen sound.
        const sound = selectVoiceStateSound(
          { muted: prev.current.effectiveMuted, deafened: prev.current.effectiveDeafened },
          { muted: eff.muted, deafened: eff.deafened },
        );
        if (sound) audioManager.playSound(sound, sfxOpts);
      }
      prev.current.effectiveMuted = eff.muted;
      prev.current.effectiveDeafened = eff.deafened;

      // -------- Camera Toggle (self) --------
      if (state.isCameraOn !== prev.current.isCameraOn) {
        audioManager.playSound(state.isCameraOn ? 'camera_on' : 'camera_off', sfxOpts);
        prev.current.isCameraOn = state.isCameraOn;
      }

      // -------- Self connect / disconnect --------
      const justDisconnected = prev.current.inRoom && !inRoom;
      const justConnected = !prev.current.inRoom && inRoom;

      if (justDisconnected) {
        audioManager.playSound('disconnect', sfxOpts);
      }
      if (justConnected) {
        audioManager.playSound('user_join', sfxOpts);
      }
      prev.current.inRoom = inRoom;

      // -------- Participant set diff --------
      const currentParticipantIds = new Set(state.participants.map((p) => p.userId));
      const currentScreenShareUserIds = new Set(
        state.participants.filter((p) => p.isScreenSharing).map((p) => p.userId),
      );

      // Our own share. While we are not listed (the participant list is empty
      // after a disconnect) the identity we were listed under still names the
      // watcher set that has to be cleared.
      const self = localShareOf(state.participants);
      const selfIdentity = self.identity ?? prev.current.selfIdentity;
      const selfIsSharing = self.sharing;
      const selfStreamJustStarted = selfIsSharing && !prev.current.selfSharing;
      const selfStreamJustEnded = !selfIsSharing && prev.current.selfSharing;
      prev.current.selfIdentity = selfIdentity;
      prev.current.selfSharing = selfIsSharing;

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

      if (!reconnecting) {
        prev.current.participantIds = currentParticipantIds;
        prev.current.screenShareUserIds = currentScreenShareUserIds;
      }

      // -------- Viewer tracking — streamer-side only (§3.2) --------
      // The full diff is gated on `selfIsSharing`. When self isn't sharing,
      // both prev and current are forced to ∅ — no sounds fire even if a late
      // ping mutates the store. On both stream-start and stream-end transitions
      // for self, eagerly call clearStreamWatchers; the gate makes the
      // re-entered subscriber tick silent. This eliminates the race where a
      // late "Stop Watching" ping arriving between a deferred clear's schedule
      // and execution would fire phantom stream_user_joined / left.
      if (selfIdentity && (selfStreamJustStarted || selfStreamJustEnded)) {
        useVoiceStore.getState().clearStreamWatchers(selfIdentity);
      }

      if (reconnecting) {
        // Keep the watcher baseline until the room is back.
      } else if (selfIdentity && state.isLiveKitConnected && !justDisconnected && selfIsSharing) {
        const live = new Set(state.streamWatchers.get(selfIdentity) ?? []);
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
      syncIncomingRing();

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

    // -------- Chat: message sound (the `message` alert rule, sounds.md) --------
    const unsubscribeChat = useChatStore.subscribe((state, prevState) => {
      if (isInitialMount.current) return;

      const newEvents = addedRealtimeMessageEvents(prevState.realtimeMessageEvents, state.realtimeMessageEvents);
      if (newEvents.length === 0) return;
      const everyMessage = useVoiceStore.getState().messageSoundAllChannels;
      if (newEvents.some((event) => messageAlertsUser(event, { everyMessage }))) {
        void playAlertSound('message');
      }
    });

    const unsubscribeAuth = useAuthStore.subscribe((state, prevState) => {
      if (isInitialMount.current) return;
      if (selectMyChosenStatus(state) !== selectMyChosenStatus(prevState)) syncIncomingRing();
    });

    return () => {
      clearTimeout(timer);
      unsubscribeVoice();
      unsubscribeChat();
      unsubscribeAuth();
      if (incomingCallLoop.current) incomingCallLoop.current.stop();
      if (outgoingCallLoop.current) outgoingCallLoop.current.stop();
    };
  }, [currentUser?.id, currentUser?.homeUserId]);

  return null;
}
