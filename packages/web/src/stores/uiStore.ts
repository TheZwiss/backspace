import { create } from 'zustand';

type ModalType =
  | 'createServer'
  | 'joinServer'
  | 'createChannel'
  | 'invite'
  | 'userSettings'
  | 'serverSettings'
  | 'imagePreview'
  | null;

interface UIState {
  sidebarOpen: boolean;
  memberListOpen: boolean;
  activeModal: ModalType;
  modalData: Record<string, unknown>;
  isMobile: boolean;
  showDms: boolean;
  imagePreviewUrl: string | null;
  toggleSidebar: () => void;
  toggleMemberList: () => void;
  openModal: (modal: ModalType, data?: Record<string, unknown>) => void;
  closeModal: () => void;
  setIsMobile: (isMobile: boolean) => void;
  setShowDms: (show: boolean) => void;
  openImagePreview: (url: string) => void;
  closeImagePreview: () => void;
}

export const useUIStore = create<UIState>((set) => ({
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
