import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User } from '@backspace/shared';

type ModalType =
  | 'createServer'
  | 'joinServer'
  | 'createChannel'
  | 'invite'
  | 'userSettings'
  | 'serverSettings'
  | 'channelSettings'
  | 'imagePreview'
  | 'newDm'
  | 'addDmMember'
  | null;

interface Toast {
  id: string;
  message: string;
  type: 'info' | 'warning' | 'success';
}

interface UIState {
  sidebarOpen: boolean;
  memberListOpen: boolean;
  activeModal: ModalType;
  modalData: Record<string, unknown>;
  isMobile: boolean;
  showDms: boolean;
  showExplore: boolean;
  imagePreviewUrl: string | null;
  userProfilePopout: {
    user: User | null;
    position: { top: number; left: number } | null;
  };
  toasts: Toast[];
  toggleSidebar: () => void;
  toggleMemberList: () => void;
  openModal: (modal: ModalType, data?: Record<string, unknown>) => void;
  closeModal: () => void;
  setIsMobile: (isMobile: boolean) => void;
  setShowDms: (show: boolean) => void;
  setShowExplore: (show: boolean) => void;
  openImagePreview: (url: string) => void;
  closeImagePreview: () => void;
  openUserProfile: (user: User, position: { top: number; left: number }) => void;
  closeUserProfile: () => void;
  addToast: (message: string, type?: 'info' | 'warning' | 'success', duration?: number) => void;
  removeToast: (id: string) => void;
  voiceChatOpen: boolean;
  voiceFullscreen: boolean;
  pipCollapsed: boolean;
  toggleVoiceChat: () => void;
  toggleVoiceFullscreen: () => void;
  setVoiceFullscreen: (fullscreen: boolean) => void;
  setPipCollapsed: (collapsed: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      memberListOpen: true,
      activeModal: null,
      modalData: {},
      isMobile: false,
      showDms: false,
      showExplore: false,
      imagePreviewUrl: null,
      userProfilePopout: {
        user: null,
        position: null,
      },
      toasts: [],

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      toggleMemberList: () => set((state) => ({ memberListOpen: !state.memberListOpen })),

      openModal: (modal, data = {}) => set({ activeModal: modal, modalData: data }),
      closeModal: () => set({ activeModal: null, modalData: {} }),

      setIsMobile: (isMobile) => {
        const prev = get().isMobile;
        if (prev === isMobile) return;
        if (isMobile) {
          set({ isMobile, sidebarOpen: false, memberListOpen: false });
        } else {
          // On desktop transition, restore sidebarOpen but leave memberListOpen
          // at its persisted/toggled value — don't override user preference
          set({ isMobile, sidebarOpen: true });
        }
      },

      setShowDms: (show) => set({ showDms: show, ...(show ? { showExplore: false } : {}) }),
      setShowExplore: (show) => set({ showExplore: show, ...(show ? { showDms: false } : {}) }),

      openImagePreview: (url) => set({ activeModal: 'imagePreview', imagePreviewUrl: url }),
      closeImagePreview: () => set({ activeModal: null, imagePreviewUrl: null }),

      openUserProfile: (user, position) => set({
        userProfilePopout: { user, position }
      }),
      closeUserProfile: () => set({
        userProfilePopout: { user: null, position: null }
      }),

      addToast: (message, type = 'info', duration = 5000) => {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
        set((state) => ({ toasts: [...state.toasts, { id, message, type }] }));
        setTimeout(() => {
          set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) }));
        }, duration);
      },
      removeToast: (id) => set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) })),

      voiceChatOpen: false,
      voiceFullscreen: false,
      pipCollapsed: false,
      toggleVoiceChat: () => set((state) => ({ voiceChatOpen: !state.voiceChatOpen })),
      toggleVoiceFullscreen: () => set((state) => ({ voiceFullscreen: !state.voiceFullscreen })),
      setVoiceFullscreen: (fullscreen) => set({ voiceFullscreen: fullscreen }),
      setPipCollapsed: (collapsed) => set({ pipCollapsed: collapsed }),
    }),
    {
      name: 'backspace-ui-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        memberListOpen: state.memberListOpen,
      }),
    }
  )
);
