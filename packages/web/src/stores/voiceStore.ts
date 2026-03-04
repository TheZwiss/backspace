import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ParticipantInfo } from '../hooks/useLiveKit';
import { AudioManager } from '../audio/AudioManager';
import { useServerStore } from './serverStore';

export interface ScreenShareConfig {
  height: 1080 | 720 | 540;
  fps: 60 | 45 | 30;
  mode: 'gaming' | 'text';
  customBitrateKbps: number | null;
}

interface VoiceState {
  voiceUsers: Map<string, string[]>; // channelId → userIds
  currentVoiceChannelId: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  participants: ParticipantInfo[];
  speakingParticipantIds: Set<string>;
  connectionError: string | null;
  isLiveKitConnected: boolean;
  connectionQuality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
  setConnectionQuality: (q: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown') => void;
  inputVolume: number;  // 0-200 (100 = default)
  outputVolume: number; // 0-200 (100 = default)
  inputDeviceId: string;
  outputDeviceId: string;
  focusedParticipantId: string | null;
  screenShareConfig: ScreenShareConfig;
  // Per-participant volume (userId → 0-200, 100 = default)
  participantVolumes: Map<string, number>;
  setParticipantVolume: (userId: string, volume: number) => void;
  getParticipantVolume: (userId: string) => number;
  // Stream widget state
  streamVolumes: Map<string, number>;       // userId → 0-200 (100 default)
  streamMutes: Map<string, boolean>;        // userId → muted?
  watchingStreams: Set<string>;             // userIds we're watching
  streamAttenuationEnabled: boolean;        // global toggle, default true
  streamAttenuationStrength: number;        // 0-100, default 50
  setStreamVolume: (userId: string, volume: number) => void;
  setStreamMute: (userId: string, muted: boolean) => void;
  watchStream: (userId: string) => void;
  unwatchStream: (userId: string) => void;
  clearStreamVolume: (userId: string) => void;
  clearStreamMute: (userId: string) => void;
  setStreamAttenuationEnabled: (enabled: boolean) => void;
  setStreamAttenuationStrength: (strength: number) => void;
  // DM call state
  incomingCall: { dmChannelId: string; callerId: string; callerName: string } | null;
  outgoingCall: { dmChannelId: string } | null;
  activeDmCall: { dmChannelId: string } | null;
  setIncomingCall: (call: { dmChannelId: string; callerId: string; callerName: string } | null) => void;
  setOutgoingCall: (call: { dmChannelId: string } | null) => void;
  setActiveDmCall: (call: { dmChannelId: string } | null) => void;
  setVoiceUsers: (channelId: string, userIds: string[]) => void;
  addVoiceUser: (channelId: string, userId: string) => void;
  removeVoiceUser: (channelId: string, userId: string) => void;
  setCurrentVoiceChannel: (channelId: string | null) => void;
  setParticipants: (participants: ParticipantInfo[]) => void;
  setSpeakingParticipants: (ids: Set<string>) => void;
  setConnectionError: (error: string | null) => void;
  setIsLiveKitConnected: (connected: boolean) => void;
  setInputVolume: (volume: number) => void;
  setOutputVolume: (volume: number) => void;
  setInputDevice: (deviceId: string) => void;
  setOutputDevice: (deviceId: string) => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleScreenShare: () => void;
  toggleDeafen: () => void;
  setFocusedParticipant: (id: string | null) => void;
  setScreenShareConfig: (config: Partial<ScreenShareConfig>) => void;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  rnnoiseEnabled: boolean;
  setEchoCancellation: (enabled: boolean) => void;
  setAutoGainControl: (enabled: boolean) => void;
  setRnnoiseEnabled: (enabled: boolean) => void;
  deafenedUserIds: Set<string>;
  setUserDeafened: (userId: string, deafened: boolean) => void;
  // WebSocket-based voice user status (visible without joining LiveKit)
  voiceUserStates: Map<string, { isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isScreenSharing: boolean }>;
  setVoiceUserStatus: (userId: string, isMuted: boolean, isDeafened: boolean, isCameraOn: boolean, isScreenSharing: boolean) => void;
  clearVoiceUserStatus: (userId: string) => void;
  getVoiceUsers: (channelId: string) => string[];
  clearAllVoiceUsers: () => void;
  clearVoiceUsersForOrigin: (origin: string) => void;
  leaveVoice: () => void;
  reset: () => void;
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set, get) => ({
      voiceUsers: new Map(),
      currentVoiceChannelId: null,
      isMuted: false,
      isDeafened: false,
      isCameraOn: false,
      isScreenSharing: false,
      participants: [],
      speakingParticipantIds: new Set(),
      connectionError: null,
      isLiveKitConnected: false,
      connectionQuality: 'unknown',
      inputVolume: 100,
      outputVolume: 100,
      inputDeviceId: 'default',
      outputDeviceId: 'default',
      focusedParticipantId: null,
      screenShareConfig: { height: 720, fps: 60, mode: 'gaming', customBitrateKbps: null },
      participantVolumes: new Map(),
      setParticipantVolume: (userId, volume) => {
        set((state) => {
          const newMap = new Map(state.participantVolumes);
          newMap.set(userId, volume);
          return { participantVolumes: newMap };
        });
      },
      getParticipantVolume: (userId) => get().participantVolumes.get(userId) ?? 100,

      // Stream widget state
      streamVolumes: new Map(),
      streamMutes: new Map(),
      watchingStreams: new Set(),
      streamAttenuationEnabled: false,
      streamAttenuationStrength: 50,

      setStreamVolume: (userId, volume) => {
        set((state) => {
          const newMap = new Map(state.streamVolumes);
          newMap.set(userId, volume);
          return { streamVolumes: newMap };
        });
      },
      setStreamMute: (userId, muted) => {
        set((state) => {
          const newMap = new Map(state.streamMutes);
          newMap.set(userId, muted);
          return { streamMutes: newMap };
        });
      },
      watchStream: (userId) => {
        set((state) => {
          const newSet = new Set(state.watchingStreams);
          newSet.add(userId);
          return { watchingStreams: newSet };
        });
      },
      unwatchStream: (userId) => {
        set((state) => {
          const newSet = new Set(state.watchingStreams);
          newSet.delete(userId);
          return { watchingStreams: newSet };
        });
      },
      clearStreamVolume: (userId) => {
        set((state) => {
          const newMap = new Map(state.streamVolumes);
          newMap.delete(userId);
          return { streamVolumes: newMap };
        });
      },
      clearStreamMute: (userId) => {
        set((state) => {
          const newMap = new Map(state.streamMutes);
          newMap.delete(userId);
          return { streamMutes: newMap };
        });
      },
      setStreamAttenuationEnabled: (enabled) => set({ streamAttenuationEnabled: enabled }),
      setStreamAttenuationStrength: (strength) => set({ streamAttenuationStrength: strength }),

      incomingCall: null,
      outgoingCall: null,
      activeDmCall: null,

      setIncomingCall: (call) => set({ incomingCall: call }),
      setOutgoingCall: (call) => set({ outgoingCall: call }),
      setActiveDmCall: (call) => set({ activeDmCall: call }),

      setVoiceUsers: (channelId, userIds) => {
        set((state) => {
          const newMap = new Map(state.voiceUsers);
          newMap.set(channelId, userIds);
          return { voiceUsers: newMap };
        });
      },

      addVoiceUser: (channelId, userId) => {
        set((state) => {
          const newMap = new Map(state.voiceUsers);
          const current = newMap.get(channelId) ?? [];
          if (!current.includes(userId)) {
            newMap.set(channelId, [...current, userId]);
          }
          return { voiceUsers: newMap };
        });
      },

      removeVoiceUser: (channelId, userId) => {
        set((state) => {
          const newMap = new Map(state.voiceUsers);
          const current = newMap.get(channelId) ?? [];
          newMap.set(channelId, current.filter(id => id !== userId));
          return { voiceUsers: newMap };
        });
      },

      setCurrentVoiceChannel: (channelId) => set({ 
        currentVoiceChannelId: channelId,
        activeDmCall: null // Clear active DM call when joining a server channel
      }),

      setParticipants: (participants) => set({ participants }),
      setSpeakingParticipants: (ids) => set({ speakingParticipantIds: ids }),
      setConnectionError: (error) => set({ connectionError: error }),
      setIsLiveKitConnected: (connected) => set({ isLiveKitConnected: connected }),
      setConnectionQuality: (quality) => set({ connectionQuality: quality }),

      setInputVolume: (volume) => {
        set({ inputVolume: volume });
        AudioManager.getInstance().setInputVolume(volume);
      },
      setOutputVolume: (volume) => set({ outputVolume: volume }),
      
      setInputDevice: (deviceId) => set({ inputDeviceId: deviceId }),
      
      setOutputDevice: (deviceId) => set({ outputDeviceId: deviceId }),

      toggleMic: () => set((state) => ({ isMuted: !state.isMuted })),
      toggleDeafen: () => set((state) => ({ isDeafened: !state.isDeafened })),
      toggleCamera: () => set((state) => ({ isCameraOn: !state.isCameraOn })),
      toggleScreenShare: () => set((state) => ({ isScreenSharing: !state.isScreenSharing })),

      setFocusedParticipant: (id) => set({ focusedParticipantId: id }),
      setScreenShareConfig: (config) => set((state) => ({
        screenShareConfig: { ...state.screenShareConfig, ...config },
      })),
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: false,
      rnnoiseEnabled: true,
      setEchoCancellation: (enabled) => set({ echoCancellation: enabled }),
      setAutoGainControl: (enabled) => set({ autoGainControl: enabled }),
      setRnnoiseEnabled: (enabled) => set({ rnnoiseEnabled: enabled }),
      deafenedUserIds: new Set(),
      setUserDeafened: (userId, deafened) => {
        set((state) => {
          const newSet = new Set(state.deafenedUserIds);
          if (deafened) newSet.add(userId); else newSet.delete(userId);
          return { deafenedUserIds: newSet };
        });
      },

      voiceUserStates: new Map(),
      setVoiceUserStatus: (userId, isMuted, isDeafened, isCameraOn, isScreenSharing) => {
        set((state) => {
          const newMap = new Map(state.voiceUserStates);
          newMap.set(userId, { isMuted, isDeafened, isCameraOn, isScreenSharing });
          return { voiceUserStates: newMap };
        });
      },
      clearVoiceUserStatus: (userId) => {
        set((state) => {
          const newMap = new Map(state.voiceUserStates);
          newMap.delete(userId);
          return { voiceUserStates: newMap };
        });
      },

      getVoiceUsers: (channelId) => get().voiceUsers.get(channelId) ?? [],

      clearAllVoiceUsers: () => set({ voiceUsers: new Map(), voiceUserStates: new Map() }),

      clearVoiceUsersForOrigin: (origin: string) => {
        const { channelOriginMap } = useServerStore.getState();
        set((state) => {
          const newVoiceUsers = new Map(state.voiceUsers);
          for (const [channelId] of newVoiceUsers) {
            if ((channelOriginMap.get(channelId) ?? '') === origin) {
              newVoiceUsers.delete(channelId);
            }
          }
          return { voiceUsers: newVoiceUsers };
        });
      },

      // Leave voice without wiping the voiceUsers map (so sidebar still shows others)
      leaveVoice: () => set({
        currentVoiceChannelId: null,
        isCameraOn: false,
        isScreenSharing: false,
        participants: [],
        speakingParticipantIds: new Set(),
        connectionError: null,
        isLiveKitConnected: false,
        connectionQuality: 'unknown',
        focusedParticipantId: null,
        activeDmCall: null,
        outgoingCall: null,
        deafenedUserIds: new Set(),
        streamVolumes: new Map(),
        streamMutes: new Map(),
        watchingStreams: new Set(),
      }),

      reset: () => set({
        voiceUsers: new Map(),
        currentVoiceChannelId: null,
        isMuted: false,
        isDeafened: false,
        isCameraOn: false,
        isScreenSharing: false,
        participants: [],
        speakingParticipantIds: new Set(),
        connectionError: null,
        isLiveKitConnected: false,
        connectionQuality: 'unknown',
        inputVolume: 100,
        outputVolume: 100,
        inputDeviceId: 'default',
        outputDeviceId: 'default',
        focusedParticipantId: null,
        participantVolumes: new Map(),
        incomingCall: null,
        outgoingCall: null,
        activeDmCall: null,
        deafenedUserIds: new Set(),
        voiceUserStates: new Map(),
        streamVolumes: new Map(),
        streamMutes: new Map(),
        watchingStreams: new Set(),
      }),
    }),
    {
      name: 'backspace-voice-settings',
      version: 6,
      migrate: (persistedState: any, version: number) => {
        if (version === 0) {
          persistedState.streamAttenuationEnabled = false;
        }
        if (version < 2) {
          persistedState.echoCancellation = true;
          persistedState.autoGainControl = false;
        }
        if (version < 4) {
          persistedState.rnnoiseEnabled = true;
          persistedState.noiseSuppression = true;
        }
        if (version < 5) {
          const vq = persistedState.videoQuality as string | undefined;
          let height: 1080 | 720 | 540 = 720;
          let fps: 60 | 45 | 30 = 60;
          if (vq) {
            if (vq.startsWith('1080')) height = 1080;
            else if (vq.startsWith('540') || vq.startsWith('360')) height = 540;
            fps = vq.endsWith('60') ? 60 : 30;
          }
          persistedState.screenShareConfig = { height, fps, mode: 'gaming' };
          delete persistedState.videoQuality;
        }
        if (version < 6) {
          if (persistedState.screenShareConfig) {
            persistedState.screenShareConfig.customBitrateKbps = null;
          }
        }
        return persistedState;
      },
      storage: createJSONStorage(() => localStorage),
      // Only persist these keys. Maps and Sets are complex to serialize.
      // noiseSuppression is intentionally excluded — always true internally,
      // managed automatically by AudioManager based on RNNoise state.
      partialize: (state) => ({
        currentVoiceChannelId: state.currentVoiceChannelId,
        isMuted: state.isMuted,
        isDeafened: state.isDeafened,
        inputVolume: state.inputVolume,
        outputVolume: state.outputVolume,
        inputDeviceId: state.inputDeviceId,
        outputDeviceId: state.outputDeviceId,
        screenShareConfig: state.screenShareConfig,
        echoCancellation: state.echoCancellation,
        autoGainControl: state.autoGainControl,
        rnnoiseEnabled: state.rnnoiseEnabled,
        streamAttenuationEnabled: state.streamAttenuationEnabled,
        streamAttenuationStrength: state.streamAttenuationStrength,
      }),
    }
  )
);
