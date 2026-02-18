import { create } from 'zustand';
export const useUIStore = create((set) => ({
    sidebarOpen: true,
    memberListOpen: true,
    activeModal: null,
    modalData: {},
    isMobile: false,
    showDms: false,
    imagePreviewUrl: null,
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
}));
