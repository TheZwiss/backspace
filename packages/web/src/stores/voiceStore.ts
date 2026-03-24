import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ParticipantInfo } from '../hooks/useLiveKit';
import { AudioManager } from '../audio/AudioManager';
import { useSpaceStore, getChannelOrigin, getMyUserIdForOrigin } from './spaceStore';
import { useAuthStore } from './authStore';
import { isElectron } from '../platform/platform';

export interface ScreenShareConfig {
  height: number | 'native';
  fps: number;
  mode: 'gaming' | 'text';
  customBitrateKbps: number | null;
  shareAudio: boolean;
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
  speakingUserIds: Set<string>;
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
  // Per-participant local mute (userId → muted?)
  participantMutes: Map<string, boolean>;
  setParticipantMute: (userId: string, muted: boolean) => void;
  // Stream widget state
  streamVolumes: Map<string, number>;       // userId → 0-200 (100 default)
  streamMutes: Map<string, boolean>;        // userId → muted?
  watchingStreams: Set<string>;             // userIds we're watching
  unwatchedCameras: Set<string>;           // userIds whose cameras we've opted out of
  soundEffectVolume: number;                 // 0-200 (100 = default)
  setSoundEffectVolume: (volume: number) => void;
  streamAttenuationEnabled: boolean;        // global toggle, default true
  streamAttenuationStrength: number;        // 0-100, default 50
  setStreamVolume: (userId: string, volume: number) => void;
  setStreamMute: (userId: string, muted: boolean) => void;
  watchStream: (userId: string) => void;
  unwatchStream: (userId: string) => void;
  unwatchCamera: (userId: string) => void;
  rewatchCamera: (userId: string) => void;
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
  pttActive: boolean;
  setMuted: (muted: boolean) => void;
  setPttActive: (active: boolean) => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleScreenShare: () => void;
  toggleDeafen: () => void;
  setFocusedParticipant: (id: string | null) => void;
  setScreenShareConfig: (config: Partial<ScreenShareConfig>) => void;
  hwOverdrive: boolean;
  setHwOverdrive: (enabled: boolean) => void;
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
  // Space mute/deafen state (moderator action)
  spaceMutedUserIds: Set<string>; // Stores "spaceId:userId"
  spaceDeafenedUserIds: Set<string>; // Stores "spaceId:userId"
  setSpaceMutedUser: (spaceId: string, userId: string, muted: boolean) => void;
  setSpaceDeafenedUser: (spaceId: string, userId: string, deafened: boolean) => void;
  clearSpaceVoiceStates: () => void;
  // Permission mute state (SPEAK permission revoked while in voice)
  permissionMutedUserIds: Set<string>; // Stores "spaceId:userId"
  setPermissionMutedUser: (spaceId: string, userId: string, muted: boolean) => void;
  getVoiceUsers: (channelId: string) => string[];
  clearAllVoiceUsers: () => void;
  resetSession: () => void;
  clearVoiceUsersForOrigin: (origin: string) => void;
  leaveVoice: () => void;
  handleForceDisconnect: () => void;
  // Gesture-aware connect/disconnect refs — registered by AppLayout from useLiveKit()
  connectFn: ((channelId: string, isDm?: boolean) => Promise<void>) | null;
  disconnectFn: (() => Promise<void>) | null;
  setConnectFn: (fn: ((channelId: string, isDm?: boolean) => Promise<void>) | null) => void;
  setDisconnectFn: (fn: (() => Promise<void>) | null) => void;
  reset: () => void;
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set, get) => ({
      voiceUsers: new Map(),
      currentVoiceChannelId: null,
      isMuted: false,
      pttActive: false,
      isDeafened: false,
      isCameraOn: false,
      isScreenSharing: false,
      participants: [],
      speakingParticipantIds: new Set(),
      speakingUserIds: new Set(),
      connectionError: null,
      isLiveKitConnected: false,
      connectionQuality: 'unknown',
      inputVolume: 100,
      outputVolume: 100,
      inputDeviceId: 'default',
      outputDeviceId: 'default',
      focusedParticipantId: null,
      screenShareConfig: { height: 720, fps: 60, mode: 'gaming', customBitrateKbps: null, shareAudio: !isElectron() },
      participantVolumes: new Map(),
      setParticipantVolume: (userId, volume) => {
        set((state) => {
          const newMap = new Map(state.participantVolumes);
          newMap.set(userId, volume);
          return { participantVolumes: newMap };
        });
      },
      getParticipantVolume: (userId) => get().participantVolumes.get(userId) ?? 100,

      participantMutes: new Map(),
      setParticipantMute: (userId, muted) => {
        set((state) => {
          const newMap = new Map(state.participantMutes);
          newMap.set(userId, muted);
          return { participantMutes: newMap };
        });
      },

      soundEffectVolume: 100,
      setSoundEffectVolume: (volume) => set({ soundEffectVolume: volume }),

      // Stream widget state
      streamVolumes: new Map(),
      streamMutes: new Map(),
      watchingStreams: new Set(),
      unwatchedCameras: new Set(),
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
      unwatchCamera: (userId) => {
        set((state) => {
          const newSet = new Set(state.unwatchedCameras);
          newSet.add(userId);
          return { unwatchedCameras: newSet };
        });
      },
      rewatchCamera: (userId) => {
        set((state) => {
          const newSet = new Set(state.unwatchedCameras);
          newSet.delete(userId);
          return { unwatchedCameras: newSet };
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
      setSpeakingParticipants: (ids) => {
        const userIds = new Set<string>();
        for (const id of ids) {
          const sep = id.indexOf(':');
          if (sep !== -1) userIds.add(id.substring(0, sep));
        }
        set({ speakingParticipantIds: ids, speakingUserIds: userIds });
      },
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

      setMuted: (muted: boolean) => set({ isMuted: muted }),
      setPttActive: (active: boolean) => set({ pttActive: active }),

      toggleMic: () => set((state) => {
        // User intent toggle — effective state (intent || serverEnforcement) is
        // computed at broadcast/hardware time, so the mic stays off while server-muted
        // even if the user toggles isMuted to false.
        if (state.isMuted && state.isDeafened) {
          // Unmuting while deafened → clear both (Discord behavior)
          return { isMuted: false, isDeafened: false };
        }
        return { isMuted: !state.isMuted };
      }),
      toggleDeafen: () => set((state) => {
        // User intent toggle — same decoupled model as toggleMic.
        if (state.isDeafened) {
          // Undeafening → clear both
          return { isMuted: false, isDeafened: false };
        }
        // Deafening → set both
        return { isMuted: true, isDeafened: true };
      }),
      toggleCamera: () => set((state) => ({ isCameraOn: !state.isCameraOn })),
      toggleScreenShare: () => set((state) => ({ isScreenSharing: !state.isScreenSharing })),

      setFocusedParticipant: (id) => set({ focusedParticipantId: id }),
      setScreenShareConfig: (config) => set((state) => ({
        screenShareConfig: { ...state.screenShareConfig, ...config },
      })),
      // Hardware H.264 override — transient (intentionally excluded from partialize for non-persisted behavior)
      hwOverdrive: false,
      setHwOverdrive: (enabled) => set({ hwOverdrive: enabled }),
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
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

      spaceMutedUserIds: new Set(),
      spaceDeafenedUserIds: new Set(),
      setSpaceMutedUser: (spaceId, userId, muted) => {
        set((state) => {
          const newSet = new Set(state.spaceMutedUserIds);
          const key = `${spaceId}:${userId}`;
          if (muted) newSet.add(key); else newSet.delete(key);
          return { spaceMutedUserIds: newSet };
        });
      },
      setSpaceDeafenedUser: (spaceId, userId, deafened) => {
        set((state) => {
          const newSet = new Set(state.spaceDeafenedUserIds);
          const key = `${spaceId}:${userId}`;
          if (deafened) newSet.add(key); else newSet.delete(key);
          return { spaceDeafenedUserIds: newSet };
        });
      },
      clearSpaceVoiceStates: () => set({ spaceMutedUserIds: new Set(), spaceDeafenedUserIds: new Set(), permissionMutedUserIds: new Set() }),

      permissionMutedUserIds: new Set(),
      setPermissionMutedUser: (spaceId, userId, muted) => {
        set((state) => {
          const newSet = new Set(state.permissionMutedUserIds);
          const key = `${spaceId}:${userId}`;
          if (muted) newSet.add(key); else newSet.delete(key);
          return { permissionMutedUserIds: newSet };
        });
      },

      getVoiceUsers: (channelId) => get().voiceUsers.get(channelId) ?? [],

      clearAllVoiceUsers: () => set({ voiceUsers: new Map(), voiceUserStates: new Map() }),

      resetSession: () => set({
        // Connection state
        voiceUsers: new Map(),
        voiceUserStates: new Map(),
        currentVoiceChannelId: null,
        participants: [],
        speakingParticipantIds: new Set(),
        speakingUserIds: new Set(),
        connectionError: null,
        isLiveKitConnected: false,
        connectionQuality: 'unknown',
        focusedParticipantId: null,
        // Call state
        incomingCall: null,
        outgoingCall: null,
        activeDmCall: null,
        // Per-session media state
        isCameraOn: false,
        isScreenSharing: false,
        deafenedUserIds: new Set(),
        streamVolumes: new Map(),
        streamMutes: new Map(),
        watchingStreams: new Set(),
        unwatchedCameras: new Set(),
        // Space-enforced restrictions
        spaceMutedUserIds: new Set(),
        spaceDeafenedUserIds: new Set(),
        permissionMutedUserIds: new Set(),
      }),

      clearVoiceUsersForOrigin: (origin: string) => {
        const { channelOriginMap } = useSpaceStore.getState();
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
      leaveVoice: () => {
        const channelId = get().currentVoiceChannelId;
        const myId = channelId ? getMyUserIdForOrigin(getChannelOrigin(channelId)) : undefined;

        set((state) => {
          // Optimistic: immediately remove self from the channel's voice users
          const voiceUsers = (channelId && myId)
            ? (() => {
                const m = new Map(state.voiceUsers);
                m.set(channelId, (m.get(channelId) ?? []).filter(id => id !== myId));
                return m;
              })()
            : state.voiceUsers;

          return {
            currentVoiceChannelId: null,
            isCameraOn: false,
            isScreenSharing: false,
            participants: [],
            speakingParticipantIds: new Set(),
            speakingUserIds: new Set(),
            connectionError: null,
            isLiveKitConnected: false,
            connectionQuality: 'unknown',
            focusedParticipantId: null,
            activeDmCall: null,
            outgoingCall: null,
            deafenedUserIds: new Set(),
            participantMutes: new Map(),
            streamVolumes: new Map(),
            streamMutes: new Map(),
            watchingStreams: new Set(),
            unwatchedCameras: new Set(),
            voiceUsers,
          };
        });
      },

      // Gesture-aware connect/disconnect refs — set by AppLayout, read by click handlers
      connectFn: null,
      disconnectFn: null,
      setConnectFn: (fn) => set({ connectFn: fn }),
      setDisconnectFn: (fn) => set({ disconnectFn: fn }),

      // Force disconnect: clear local connection state but do NOT touch voiceUsers.
      // Used for involuntary disconnects (identity collision, server shutdown, etc.)
      // where the server is the authority on who's actually in voice.
      handleForceDisconnect: () => {
        set({
          currentVoiceChannelId: null,
          isCameraOn: false,
          isScreenSharing: false,
          participants: [],
          speakingParticipantIds: new Set(),
          speakingUserIds: new Set(),
          connectionError: null,
          isLiveKitConnected: false,
          connectionQuality: 'unknown',
          focusedParticipantId: null,
          activeDmCall: null,
          outgoingCall: null,
          deafenedUserIds: new Set(),
          participantMutes: new Map(),
          streamVolumes: new Map(),
          streamMutes: new Map(),
          watchingStreams: new Set(),
          unwatchedCameras: new Set(),
        });
      },

      reset: () => set({
        voiceUsers: new Map(),
        currentVoiceChannelId: null,
        isMuted: false,
        isDeafened: false,
        isCameraOn: false,
        isScreenSharing: false,
        participants: [],
        speakingParticipantIds: new Set(),
        speakingUserIds: new Set(),
        connectionError: null,
        isLiveKitConnected: false,
        connectionQuality: 'unknown',
        inputVolume: 100,
        outputVolume: 100,
        inputDeviceId: 'default',
        outputDeviceId: 'default',
        focusedParticipantId: null,
        participantVolumes: new Map(),
        participantMutes: new Map(),
        incomingCall: null,
        outgoingCall: null,
        activeDmCall: null,
        deafenedUserIds: new Set(),
        voiceUserStates: new Map(),
        streamVolumes: new Map(),
        streamMutes: new Map(),
        watchingStreams: new Set(),
        unwatchedCameras: new Set(),
        spaceMutedUserIds: new Set(),
        spaceDeafenedUserIds: new Set(),
        permissionMutedUserIds: new Set(),
      }),
    }),
    {
      name: 'backspace-voice-settings',
      version: 13,
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
        if (version < 7) {
          // No data migration needed — Sets will be populated from server on next connect
        }
        if (version < 8) {
          persistedState.soundEffectVolume = 100;
        }
        if (version < 9) {
          delete persistedState.currentVoiceChannelId;
        }
        if (version < 10) {
          if (persistedState.screenShareConfig) {
            persistedState.screenShareConfig.shareAudio = true;
          }
        }
        if (version < 11) {
          if (persistedState.screenShareConfig) {
            persistedState.screenShareConfig.shareAudio = !isElectron();
          }
        }
        if (version < 12) {
          // Validate screenShareConfig.height after type widening
          const cfg = persistedState.screenShareConfig;
          if (cfg && typeof cfg.height !== 'number' && cfg.height !== 'native') {
            cfg.height = 1080;
          }
        }
        if (version < 13) {
          if (persistedState.screenShareConfig) {
            delete persistedState.screenShareConfig.codec;
          }
        }
        return persistedState;
      },
      storage: createJSONStorage(() => localStorage),
      // Only persist these keys. Maps and Sets are complex to serialize.
      // noiseSuppression is intentionally excluded — always true internally,
      // managed automatically by AudioManager based on RNNoise state.
      partialize: (state) => ({
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
        soundEffectVolume: state.soundEffectVolume,
        streamAttenuationEnabled: state.streamAttenuationEnabled,
        streamAttenuationStrength: state.streamAttenuationStrength,
        // Per-user preferences (Map → plain object for JSON)
        participantVolumes: Object.fromEntries(state.participantVolumes),
        participantMutes: Object.fromEntries(state.participantMutes),
      }),
      merge: (persistedState: any, currentState: VoiceState) => {
        const merged = { ...currentState, ...persistedState };
        // Reconstruct non-persisted Sets/Maps to their defaults
        merged.spaceMutedUserIds = currentState.spaceMutedUserIds;
        merged.spaceDeafenedUserIds = currentState.spaceDeafenedUserIds;
        merged.permissionMutedUserIds = currentState.permissionMutedUserIds;
        merged.voiceUsers = currentState.voiceUsers;
        merged.participants = currentState.participants;
        merged.speakingParticipantIds = currentState.speakingParticipantIds;
        merged.speakingUserIds = currentState.speakingUserIds;
        merged.deafenedUserIds = currentState.deafenedUserIds;
        merged.voiceUserStates = currentState.voiceUserStates;
        merged.participantVolumes = persistedState?.participantVolumes
          ? new Map(Object.entries(persistedState.participantVolumes))
          : currentState.participantVolumes;
        merged.participantMutes = persistedState?.participantMutes
          ? new Map(Object.entries(persistedState.participantMutes))
          : currentState.participantMutes;
        merged.streamVolumes = currentState.streamVolumes;
        merged.streamMutes = currentState.streamMutes;
        merged.watchingStreams = currentState.watchingStreams;
        merged.unwatchedCameras = currentState.unwatchedCameras;
        return merged;
      },
    }
  )
);
