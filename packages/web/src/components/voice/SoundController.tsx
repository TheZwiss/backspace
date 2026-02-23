import { useEffect, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useWebSocket } from '../../hooks/useWebSocket';
import { AudioManager } from '../../audio/AudioManager';

export function SoundController() {
  const audioManager = AudioManager.getInstance();
  const currentUser = useAuthStore((s) => s.user);
  const { isConnected: isWsConnected } = useWebSocket();

  // Refs to track previous states
  const isInitialMount = useRef(true);
  const prevIsWsConnected = useRef<boolean>(false);
  const wsDisconnectedAt = useRef<number>(0);
  const prevIsMuted = useRef<boolean>(useVoiceStore.getState().isMuted);
  const prevIsDeafened = useRef<boolean>(useVoiceStore.getState().isDeafened);
  const prevIsCameraOn = useRef<boolean>(useVoiceStore.getState().isCameraOn);
  const prevIsScreenSharing = useRef<boolean>(useVoiceStore.getState().isScreenSharing);
  const prevIsConnected = useRef<boolean>(useVoiceStore.getState().isLiveKitConnected);
  const prevParticipantIds = useRef<Set<string>>(new Set(useVoiceStore.getState().participants.map(p => p.userId)));
  const prevScreenShareUserIds = useRef<Set<string>>(new Set(useVoiceStore.getState().participants.filter(p => p.isScreenSharing).map(p => p.userId)));

  const incomingCallLoop = useRef<AudioBufferSourceNode | null>(null);
  const outgoingCallLoop = useRef<AudioBufferSourceNode | null>(null);

  // WebSocket Reconnect Sound — suppress during active voice and brief blips (<3s)
  useEffect(() => {
    if (isInitialMount.current) return;
    if (!isWsConnected && prevIsWsConnected.current) {
      // Record when we lost connection
      wsDisconnectedAt.current = Date.now();
    }
    if (isWsConnected && !prevIsWsConnected.current) {
      const isInActiveVoice = useVoiceStore.getState().isLiveKitConnected;
      const downtime = wsDisconnectedAt.current > 0 ? Date.now() - wsDisconnectedAt.current : Infinity;
      if (!isInActiveVoice && downtime > 3000) {
        audioManager.playSound('reconnect');
      }
    }
    prevIsWsConnected.current = isWsConnected;
  }, [isWsConnected, audioManager]);

  useEffect(() => {
    // Set initial mount flag to false after first run
    const timer = setTimeout(() => {
      isInitialMount.current = false;
      prevIsWsConnected.current = isWsConnected;
    }, 1000);

    // 1. Listen to Voice State Changes
    const unsubscribeVoice = useVoiceStore.subscribe((state) => {
      if (isInitialMount.current) return;

      // Mute/Unmute
      if (state.isMuted !== prevIsMuted.current) {
        audioManager.playSound(state.isMuted ? 'mute' : 'unmute');
        prevIsMuted.current = state.isMuted;
      }

      // Deafen/Undeafen
      if (state.isDeafened !== prevIsDeafened.current) {
        audioManager.playSound(state.isDeafened ? 'deafen' : 'undeafen');
        prevIsDeafened.current = state.isDeafened;
      }

      // Camera Toggle
      if (state.isCameraOn !== prevIsCameraOn.current) {
        audioManager.playSound(state.isCameraOn ? 'camera_on' : 'camera_off');
        prevIsCameraOn.current = state.isCameraOn;
      }

      // Screen Share Toggle (Self)
      if (state.isScreenSharing !== prevIsScreenSharing.current) {
        audioManager.playSound(state.isScreenSharing ? 'stream_started' : 'stream_ended');
        prevIsScreenSharing.current = state.isScreenSharing;
      }

      // Disconnect (Self)
      if (prevIsConnected.current && !state.isLiveKitConnected) {
        audioManager.playSound('disconnect');
      }
      // Connect (Self)
      if (!prevIsConnected.current && state.isLiveKitConnected) {
        audioManager.playSound('user_join');
      }
      prevIsConnected.current = state.isLiveKitConnected;

      // Participant Joins/Leaves & Screen Sharing
      const currentParticipantIds = new Set(state.participants.map(p => p.userId));
      const currentScreenShareUserIds = new Set(state.participants.filter(p => p.isScreenSharing).map(p => p.userId));
      
      if (state.isLiveKitConnected) {
        // Someone joined voice (Others only)
        state.participants.forEach(p => {
          if (!prevParticipantIds.current.has(p.userId) && p.userId !== currentUser?.id) {
            audioManager.playSound('user_join');
          }
        });

        // Someone left voice (Others only)
        prevParticipantIds.current.forEach(userId => {
          if (!currentParticipantIds.has(userId) && userId !== currentUser?.id) {
            audioManager.playSound('user_leave');
          }
        });

        // Someone started screen sharing (Others only)
        state.participants.forEach(p => {
          if (p.isScreenSharing && !prevScreenShareUserIds.current.has(p.userId) && p.userId !== currentUser?.id) {
            audioManager.playSound('stream_user_joined');
          }
        });

        // Someone stopped screen sharing (Others only)
        prevScreenShareUserIds.current.forEach(userId => {
          if (!currentScreenShareUserIds.has(userId) && userId !== currentUser?.id) {
            audioManager.playSound('stream_user_left');
          }
        });
      }
      
      prevParticipantIds.current = currentParticipantIds;
      prevScreenShareUserIds.current = currentScreenShareUserIds;

      // Incoming Call (Ringing)
      if (state.incomingCall && !incomingCallLoop.current) {
        audioManager.playSound('call_ringing', { loop: true }).then(source => {
          incomingCallLoop.current = source;
        });
      } else if (!state.incomingCall && incomingCallLoop.current) {
        incomingCallLoop.current.stop();
        incomingCallLoop.current = null;
      }

      // Outgoing Call (Calling)
      if (state.outgoingCall && !outgoingCallLoop.current) {
        audioManager.playSound('call_calling', { loop: true }).then(source => {
          outgoingCallLoop.current = source;
        });
      } else if (!state.outgoingCall && outgoingCallLoop.current) {
        outgoingCallLoop.current.stop();
        outgoingCallLoop.current = null;
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
            audioManager.playSound('message');
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
  }, [audioManager, currentUser?.id]);

  return null;
}

