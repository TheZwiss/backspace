import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { AudioManager } from '../audio/AudioManager';
export const useVoiceStore = create()(persist((set, get) => ({
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
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    focusedParticipantId: null,
    videoQuality: '720p60',
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
    setConnectionError: (error) => set({ connectionError: error }),
    setIsLiveKitConnected: (connected) => set({ isLiveKitConnected: connected }),
    setInputVolume: (volume) => {
        set({ inputVolume: volume });
        AudioManager.getInstance().setInputVolume(volume);
    },
    setOutputVolume: (volume) => set({ outputVolume: volume }),
    setInputDevice: async (deviceId) => {
        set({ inputDeviceId: deviceId });
        await AudioManager.getInstance().setInputDevice(deviceId);
    },
    setOutputDevice: (deviceId) => set({ outputDeviceId: deviceId }),
    toggleMic: () => set((state) => ({ isMuted: !state.isMuted })),
    toggleDeafen: () => set((state) => ({ isDeafened: !state.isDeafened })),
    toggleCamera: () => set((state) => ({ isCameraOn: !state.isCameraOn })),
    toggleScreenShare: () => set((state) => ({ isScreenSharing: !state.isScreenSharing })),
    setFocusedParticipant: (id) => set({ focusedParticipantId: id }),
    setVideoQuality: (quality) => set({ videoQuality: quality }),
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: false,
    toggleNoiseSuppression: () => set((state) => ({ noiseSuppression: !state.noiseSuppression })),
    setEchoCancellation: (enabled) => set({ echoCancellation: enabled }),
    setAutoGainControl: (enabled) => set({ autoGainControl: enabled }),
    deafenedUserIds: new Set(),
    setUserDeafened: (userId, deafened) => {
        set((state) => {
            const newSet = new Set(state.deafenedUserIds);
            if (deafened)
                newSet.add(userId);
            else
                newSet.delete(userId);
            return { deafenedUserIds: newSet };
        });
    },
    voiceUserStates: new Map(),
    setVoiceUserStatus: (userId, isMuted, isDeafened) => {
        set((state) => {
            const newMap = new Map(state.voiceUserStates);
            newMap.set(userId, { isMuted, isDeafened });
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
    // Leave voice without wiping the voiceUsers map (so sidebar still shows others)
    leaveVoice: () => set({
        currentVoiceChannelId: null,
        isCameraOn: false,
        isScreenSharing: false,
        participants: [],
        connectionError: null,
        isLiveKitConnected: false,
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
        connectionError: null,
        isLiveKitConnected: false,
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
}), {
    name: 'opencord-voice-settings',
    version: 2,
    migrate: (persistedState, version) => {
        if (version === 0) {
            persistedState.streamAttenuationEnabled = false;
        }
        if (version < 2) {
            persistedState.echoCancellation = true;
            persistedState.autoGainControl = false;
        }
        return persistedState;
    },
    storage: createJSONStorage(() => localStorage),
    // Only persist these keys. Maps and Sets are complex to serialize.
    partialize: (state) => ({
        currentVoiceChannelId: state.currentVoiceChannelId,
        isMuted: state.isMuted,
        isDeafened: state.isDeafened,
        inputVolume: state.inputVolume,
        outputVolume: state.outputVolume,
        inputDeviceId: state.inputDeviceId,
        outputDeviceId: state.outputDeviceId,
        videoQuality: state.videoQuality,
        noiseSuppression: state.noiseSuppression,
        echoCancellation: state.echoCancellation,
        autoGainControl: state.autoGainControl,
        streamAttenuationEnabled: state.streamAttenuationEnabled,
        streamAttenuationStrength: state.streamAttenuationStrength,
    }),
}));
