import { create } from 'zustand';
import type { ParticipantInfo } from '../hooks/useLiveKit';

interface VoiceState {
  voiceUsers: Map<string, string[]>; // channelId → userIds
  currentVoiceChannelId: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  participants: ParticipantInfo[];
  connectionError: string | null;
  isLiveKitConnected: boolean;
  inputVolume: number;  // 0-200 (100 = default)
  outputVolume: number; // 0-200 (100 = default)
  focusedParticipantId: string | null;
  videoQuality: 'auto' | '1080p' | '1080p60' | '720p' | '720p60' | '540p' | '360p';
  // Per-participant volume (userId → 0-200, 100 = default)
  participantVolumes: Map<string, number>;
  setParticipantVolume: (userId: string, volume: number) => void;
  getParticipantVolume: (userId: string) => number;
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
  setConnectionError: (error: string | null) => void;
  setIsLiveKitConnected: (connected: boolean) => void;
  setInputVolume: (volume: number) => void;
  setOutputVolume: (volume: number) => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleScreenShare: () => void;
  toggleDeafen: () => void;
  setFocusedParticipant: (id: string | null) => void;
  setVideoQuality: (quality: 'auto' | '1080p' | '1080p60' | '720p' | '720p60' | '540p' | '360p') => void;
  getVoiceUsers: (channelId: string) => string[];
  clearAllVoiceUsers: () => void;
  leaveVoice: () => void;
  reset: () => void;
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  voiceUsers: new Map(),
  currentVoiceChannelId: null,
  isMuted: false,
  isDeafened: false,
  isCameraOn: false,
  isScreenSharing: false,
  participants: [],
  connectionError: null,
  isLiveKitConnected: false,
  inputVolume: 100,
  outputVolume: 100,
  focusedParticipantId: null,
  videoQuality: 'auto',
  participantVolumes: new Map(),
  setParticipantVolume: (userId, volume) => {
    set((state) => {
      const newMap = new Map(state.participantVolumes);
      newMap.set(userId, volume);
      return { participantVolumes: newMap };
    });
  },
  getParticipantVolume: (userId) => get().participantVolumes.get(userId) ?? 100,

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

  setCurrentVoiceChannel: (channelId) => set({ currentVoiceChannelId: channelId }),

  setParticipants: (participants) => set({ participants }),
  setConnectionError: (error) => set({ connectionError: error }),
  setIsLiveKitConnected: (connected) => set({ isLiveKitConnected: connected }),

  setInputVolume: (volume) => set({ inputVolume: volume }),
  setOutputVolume: (volume) => set({ outputVolume: volume }),

  toggleMic: () => set((state) => ({ isMuted: !state.isMuted })),
  toggleDeafen: () => set((state) => ({ isDeafened: !state.isDeafened })),
  toggleCamera: () => set((state) => ({ isCameraOn: !state.isCameraOn })),
  toggleScreenShare: () => set((state) => ({ isScreenSharing: !state.isScreenSharing })),

  setFocusedParticipant: (id) => set({ focusedParticipantId: id }),
  setVideoQuality: (quality) => set({ videoQuality: quality }),

  getVoiceUsers: (channelId) => get().voiceUsers.get(channelId) ?? [],

  clearAllVoiceUsers: () => set({ voiceUsers: new Map() }),

  // Leave voice without wiping the voiceUsers map (so sidebar still shows others)
  leaveVoice: () => set({
    currentVoiceChannelId: null,
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    isScreenSharing: false,
    participants: [],
    connectionError: null,
    isLiveKitConnected: false,
    inputVolume: 100,
    outputVolume: 100,
    focusedParticipantId: null,
    activeDmCall: null,
    outgoingCall: null,
  }),

  reset: () => set({
    voiceUsers: new Map(),
    currentVoiceChannelId: null,
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    isScreenSharing: false,
    participants: [],
    connectionError: null,
    isLiveKitConnected: false,
    inputVolume: 100,
    outputVolume: 100,
    focusedParticipantId: null,
    participantVolumes: new Map(),
    incomingCall: null,
    outgoingCall: null,
    activeDmCall: null,
  }),
}));
