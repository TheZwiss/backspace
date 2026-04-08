import { useEffect, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { AudioManager } from '../../audio/AudioManager';

/** Compute the effective sound effect gain: base volume (0.8) scaled by the user's SFX slider (0–200). */
function getSfxVolume(): number {
  return 0.8 * (useVoiceStore.getState().soundEffectVolume / 100);
}

export function SoundController() {
  const audioManager = AudioManager.getInstance();
  const currentUser = useAuthStore((s) => s.user);
  // Federation-aware self-ID: in federated calls, LiveKit participant identity
  // uses homeUserId (from the home instance), not the local snowflake ID.
  // Without this, the SoundController thinks our own presence is a stranger.
  const myId = currentUser?.homeUserId || currentUser?.id;

  // Refs to track previous states
  const isInitialMount = useRef(true);
  const prevIsMuted = useRef<boolean>(useVoiceStore.getState().isMuted);
  const prevIsDeafened = useRef<boolean>(useVoiceStore.getState().isDeafened);
  const prevIsCameraOn = useRef<boolean>(useVoiceStore.getState().isCameraOn);
  const prevIsScreenSharing = useRef<boolean>(useVoiceStore.getState().isScreenSharing);
  const prevIsConnected = useRef<boolean>(useVoiceStore.getState().isLiveKitConnected);
  const prevParticipantIds = useRef<Set<string>>(new Set(useVoiceStore.getState().participants.map(p => p.userId)));
  const prevScreenShareUserIds = useRef<Set<string>>(new Set(useVoiceStore.getState().participants.filter(p => p.isScreenSharing).map(p => p.userId)));

  const incomingCallLoop = useRef<AudioBufferSourceNode | null>(null);
  const incomingCallLoading = useRef(false);  // sync guard for async playSound
  const outgoingCallLoop = useRef<AudioBufferSourceNode | null>(null);
  const outgoingCallLoading = useRef(false);

  useEffect(() => {
    // Set initial mount flag to false after first run
    const timer = setTimeout(() => {
      isInitialMount.current = false;
    }, 1000);

    // 1. Listen to Voice State Changes
    const unsubscribeVoice = useVoiceStore.subscribe((state) => {
      if (isInitialMount.current) return;

      const sfxOpts = { volume: getSfxVolume() };

      // Mute/Unmute
      if (state.isMuted !== prevIsMuted.current) {
        audioManager.playSound(state.isMuted ? 'mute' : 'unmute', sfxOpts);
        prevIsMuted.current = state.isMuted;
      }

      // Deafen/Undeafen
      if (state.isDeafened !== prevIsDeafened.current) {
        audioManager.playSound(state.isDeafened ? 'deafen' : 'undeafen', sfxOpts);
        prevIsDeafened.current = state.isDeafened;
      }

      // Camera Toggle
      if (state.isCameraOn !== prevIsCameraOn.current) {
        audioManager.playSound(state.isCameraOn ? 'camera_on' : 'camera_off', sfxOpts);
        prevIsCameraOn.current = state.isCameraOn;
      }

      // Screen Share Toggle (Self)
      if (state.isScreenSharing !== prevIsScreenSharing.current) {
        audioManager.playSound(state.isScreenSharing ? 'stream_started' : 'stream_ended', sfxOpts);
        prevIsScreenSharing.current = state.isScreenSharing;
      }

      // Self-disconnect detection — check BEFORE participant sounds
      const justDisconnected = prevIsConnected.current && !state.isLiveKitConnected;
      const justConnected = !prevIsConnected.current && state.isLiveKitConnected;

      if (justDisconnected) {
        audioManager.playSound('disconnect', sfxOpts);
      }
      if (justConnected) {
        audioManager.playSound('user_join', sfxOpts);
      }
      prevIsConnected.current = state.isLiveKitConnected;

      // Participant Joins/Leaves & Screen Sharing
      // CRITICAL: Skip entirely if we just disconnected or are not connected.
      // Without this guard, hanging up plays "user_leave" for every participant
      // (they "left" from our perspective) simultaneously with the disconnect sound.
      const currentParticipantIds = new Set(state.participants.map(p => p.userId));
      const currentScreenShareUserIds = new Set(state.participants.filter(p => p.isScreenSharing).map(p => p.userId));

      if (state.isLiveKitConnected && !justDisconnected) {
        // Someone joined voice (Others only)
        state.participants.forEach(p => {
          if (!prevParticipantIds.current.has(p.userId) && p.userId !== myId) {
            audioManager.playSound('user_join', sfxOpts);
          }
        });

        // Someone left voice (Others only)
        prevParticipantIds.current.forEach(userId => {
          if (!currentParticipantIds.has(userId) && userId !== myId) {
            audioManager.playSound('user_leave', sfxOpts);
          }
        });

        // Someone started screen sharing (Others only)
        state.participants.forEach(p => {
          if (p.isScreenSharing && !prevScreenShareUserIds.current.has(p.userId) && p.userId !== myId) {
            audioManager.playSound('stream_user_joined', sfxOpts);
          }
        });

        // Someone stopped screen sharing (Others only)
        prevScreenShareUserIds.current.forEach(userId => {
          if (!currentScreenShareUserIds.has(userId) && userId !== myId) {
            audioManager.playSound('stream_user_left', sfxOpts);
          }
        });
      }

      prevParticipantIds.current = currentParticipantIds;
      prevScreenShareUserIds.current = currentScreenShareUserIds;

      // Incoming Call (Ringing) — sync guard prevents multiple playSound during async load
      if (state.incomingCall && !incomingCallLoop.current && !incomingCallLoading.current) {
        incomingCallLoading.current = true;
        audioManager.playSound('call_ringing', { loop: true, volume: getSfxVolume() }).then(source => {
          // If call was cancelled while sound was loading, stop immediately
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

      // Outgoing Call (Calling) — same sync guard pattern
      if (state.outgoingCall && !outgoingCallLoop.current && !outgoingCallLoading.current) {
        outgoingCallLoading.current = true;
        audioManager.playSound('call_calling', { loop: true, volume: getSfxVolume() }).then(source => {
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

    // 2. Listen to Chat State Changes (New Real-Time Messages from any channel)
    const unsubscribeChat = useChatStore.subscribe((state, prevState) => {
      if (isInitialMount.current) return;

      // Only trigger on NEW realtimeMessageEvents entries (not API loads)
      if (state.realtimeMessageEvents.length > prevState.realtimeMessageEvents.length) {
        const newEvents = state.realtimeMessageEvents.slice(prevState.realtimeMessageEvents.length);
        for (const { message } of newEvents) {
          if (message.userId !== currentUser?.id) {
            audioManager.playSound('message', { volume: getSfxVolume() });
            break; // one sound per batch
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
  }, [audioManager, myId]);

  return null;
}

