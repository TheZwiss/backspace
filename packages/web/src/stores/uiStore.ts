import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User } from '@backspace/shared';

type ModalType =
  | 'createSpace'
  | 'joinSpace'
  | 'createChannel'
  | 'createCategory'
  | 'invite'
  | 'userSettings'
  | 'spaceSettings'
  | 'channelSettings'
  | 'imagePreview'
  | 'newDm'
  | 'addDmMember'
  | 'userProfile'
  | null;

interface MobileStackEntry {
  screen: string;
  params?: Record<string, string>;
}

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
  openImagePreview: (url: string) => void;
  closeImagePreview: () => void;
  openUserProfile: (user: User, position: { top: number; left: number }) => void;
  closeUserProfile: () => void;
  addToast: (message: string, type?: 'info' | 'warning' | 'success', duration?: number) => void;
  removeToast: (id: string) => void;
  lastChannelPerSpace: Record<string, string>;
  setLastChannel: (spaceId: string, channelId: string) => void;
  voiceChatOpen: boolean;
  voiceFullscreen: boolean;
  pipCollapsed: boolean;
  toggleVoiceChat: () => void;
  toggleVoiceFullscreen: () => void;
  setVoiceFullscreen: (fullscreen: boolean) => void;
  setPipCollapsed: (collapsed: boolean) => void;
  floatingPanelHeight: number;
  setFloatingPanelHeight: (height: number) => void;

  // Mobile navigation
  mobileScreen: 'spaces' | 'dms' | 'you';
  mobileStack: MobileStackEntry[];
  setMobileTab: (tab: 'spaces' | 'dms' | 'you') => void;
  pushMobileScreen: (screen: string, params?: Record<string, string>) => void;
  popMobileScreen: () => void;
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
          // On desktop transition: restore sidebar, clear mobile nav state
          // memberListOpen is NOT reset here — it keeps its persisted/toggled value
          set({ isMobile, sidebarOpen: true, mobileScreen: 'spaces' as const, mobileStack: [] });
        }
      },

      setShowDms: (show) => set({ showDms: show }),

      openImagePreview: (url) => set({ activeModal: 'imagePreview', imagePreviewUrl: url }),
      closeImagePreview: () => set({ activeModal: null, imagePreviewUrl: null }),

      openUserProfile: (user, position) => {
        if (get().isMobile) {
          // On mobile, push a full-screen user profile instead of a positioned popout
          set((state) => ({
            mobileStack: [...state.mobileStack, { screen: 'user-profile', params: { userId: user.id } }],
          }));
          history.pushState({ mobileScreen: 'user-profile' }, '');
        } else {
          set({ userProfilePopout: { user, position } });
        }
      },
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

      lastChannelPerSpace: {},
      setLastChannel: (spaceId, channelId) => set((state) => ({
        lastChannelPerSpace: { ...state.lastChannelPerSpace, [spaceId]: channelId },
      })),

      voiceChatOpen: false,
      voiceFullscreen: false,
      pipCollapsed: false,
      toggleVoiceChat: () => set((state) => ({ voiceChatOpen: !state.voiceChatOpen })),
      toggleVoiceFullscreen: () => set((state) => ({ voiceFullscreen: !state.voiceFullscreen })),
      setVoiceFullscreen: (fullscreen) => set({ voiceFullscreen: fullscreen }),
      setPipCollapsed: (collapsed) => set({ pipCollapsed: collapsed }),
      floatingPanelHeight: 140,
      setFloatingPanelHeight: (height) => set({ floatingPanelHeight: height }),

      mobileScreen: 'spaces',
      mobileStack: [],

      setMobileTab: (tab) => set({ mobileScreen: tab, mobileStack: [] }),

      pushMobileScreen: (screen, params) => {
        set((state) => ({
          mobileStack: [...state.mobileStack, { screen, params }],
        }));
        // Sync with browser history so hardware back button works
        history.pushState({ mobileScreen: screen }, '');
      },

      popMobileScreen: () => {
        const state = get();
        if (state.mobileStack.length === 0) return;
        set({ mobileStack: state.mobileStack.slice(0, -1) });
        // Note: do NOT call history.back() here if triggered by popstate event.
        // The MobileShell popstate handler manages this — see Task 5.
      },
    }),
    {
      name: 'backspace-ui-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        memberListOpen: state.memberListOpen,
        lastChannelPerSpace: state.lastChannelPerSpace,
      }),
    }
  )
);
