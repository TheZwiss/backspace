import { create } from 'zustand';
export const useVoiceStore = create((set, get) => ({
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
    noiseSuppression: true,
    toggleNoiseSuppression: () => set((state) => ({ noiseSuppression: !state.noiseSuppression })),
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
