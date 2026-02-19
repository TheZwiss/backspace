import { create } from 'zustand';
export const useUIStore = create((set) => ({
    sidebarOpen: true,
    memberListOpen: true,
    activeModal: null,
    modalData: {},
    isMobile: false,
    showDms: false,
    imagePreviewUrl: null,
    userProfilePopout: {
        user: null,
        position: null,
    },
    toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
    toggleMemberList: () => set((state) => ({ memberListOpen: !state.memberListOpen })),
    openModal: (modal, data = {}) => set({ activeModal: modal, modalData: data }),
    closeModal: () => set({ activeModal: null, modalData: {} }),
    setIsMobile: (isMobile) => set({
        isMobile,
        sidebarOpen: !isMobile,
        memberListOpen: !isMobile,
    }),
    setShowDms: (show) => set({ showDms: show }),
    openImagePreview: (url) => set({ activeModal: 'imagePreview', imagePreviewUrl: url }),
    closeImagePreview: () => set({ activeModal: null, imagePreviewUrl: null }),
    openUserProfile: (user, position) => set({
        userProfilePopout: { user, position }
    }),
    closeUserProfile: () => set({
        userProfilePopout: { user: null, position: null }
    }),
    voiceChatOpen: false,
    voiceFullscreen: false,
    pipCollapsed: false,
    toggleVoiceChat: () => set((state) => ({ voiceChatOpen: !state.voiceChatOpen })),
    toggleVoiceFullscreen: () => set((state) => ({ voiceFullscreen: !state.voiceFullscreen })),
    setVoiceFullscreen: (fullscreen) => set({ voiceFullscreen: fullscreen }),
    setPipCollapsed: (collapsed) => set({ pipCollapsed: collapsed }),
}));
