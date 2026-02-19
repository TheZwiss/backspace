import { create } from 'zustand';
import type { User } from '@opencord/shared';

type ModalType =
  | 'createServer'
  | 'joinServer'
  | 'createChannel'
  | 'invite'
  | 'userSettings'
  | 'serverSettings'
  | 'imagePreview'
  | 'newDm'
  | null;

interface UIState {
  sidebarOpen: boolean;
  memberListOpen: boolean;
  activeModal: ModalType;
  modalData: Record<string, unknown>;
  isMobile: boolean;
  showDms: boolean;
  imagePreviewUrl: string | null;
  userProfilePopout: {
    user: User | null;
    position: { top: number; left: number } | null;
  };
  toggleSidebar: () => void;
  toggleMemberList: () => void;
  openModal: (modal: ModalType, data?: Record<string, unknown>) => void;
  closeModal: () => void;
  setIsMobile: (isMobile: boolean) => void;
  setShowDms: (show: boolean) => void;
  openImagePreview: (url: string) => void;
  closeImagePreview: () => void;
  openUserProfile: (user: User, position: { top: number; left: number }) => void;
  closeUserProfile: () => void;
  voiceChatOpen: boolean;
  voiceFullscreen: boolean;
  pipCollapsed: boolean;
  toggleVoiceChat: () => void;
  toggleVoiceFullscreen: () => void;
  setVoiceFullscreen: (fullscreen: boolean) => void;
  setPipCollapsed: (collapsed: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
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
