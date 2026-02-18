import { create } from 'zustand';
export const useVoiceStore = create((set, get) => ({
    voiceUsers: new Map(),
    currentVoiceChannelId: null,
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    isScreenSharing: false,
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
    toggleMute: () => set((state) => ({ isMuted: !state.isMuted })),
    toggleDeafen: () => set((state) => ({ isDeafened: !state.isDeafened })),
    toggleCamera: () => set((state) => ({ isCameraOn: !state.isCameraOn })),
    toggleScreenShare: () => set((state) => ({ isScreenSharing: !state.isScreenSharing })),
    getVoiceUsers: (channelId) => get().voiceUsers.get(channelId) ?? [],
    reset: () => set({
        voiceUsers: new Map(),
        currentVoiceChannelId: null,
        isMuted: false,
        isDeafened: false,
        isCameraOn: false,
        isScreenSharing: false,
    }),
}));
