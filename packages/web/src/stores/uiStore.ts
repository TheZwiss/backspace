import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User } from '@backspace/shared';
import type { AnchorRect, Placement } from '../hooks/useFloatingPosition';

type ModalType =
  | 'createSpace'
  | 'joinSpace'
  | 'createChannel'
  | 'createCategory'
  | 'invite'
  | 'userSettings'
  | 'spaceSettings'
  | 'channelSettings'
  | 'categorySettings'
  | 'imagePreview'
  | 'newDm'
  | 'addDmMember'
  | 'groupDmSettings'
  | 'userProfile'
  | 'connectAndJoin'
  | 'memberRoles'
  | null;

/**
 * The space member a profile was opened for: the space, and that member's user
 * id on the space's instance (a federated member's local replicated id there,
 * not their home id). Surfaces that know they are showing a space member pass
 * it so the profile can show the member's roles; everywhere else leaves it out.
 */
export interface ProfileMemberContext {
  spaceId: string;
  userId: string;
}

interface MobileStackEntry {
  screen: string;
  params?: Record<string, string>;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: string;
  message: string;
  type: 'info' | 'warning' | 'success';
  action?: ToastAction;
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
    /** The instance that issued `user` ('' = the page's own). */
    origin: string;
    /** Rect of the element the card was opened from. The card places itself off
     *  this rect once it knows its own measured size — callers never compute
     *  coordinates, so no surface can drift by re-anchoring to itself. */
    anchor: AnchorRect | null;
    placement: Placement;
    member: ProfileMemberContext | null;
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
  /**
   * Show `user`'s profile: `origin` is the instance that issued the row, which
   * every lookup and request the profile makes goes to or is keyed by.
   */
  openUserProfile: (user: User, origin: string, anchor: AnchorRect, placement?: Placement, member?: ProfileMemberContext) => void;
  closeUserProfile: () => void;
  addToast: (message: string, type?: 'info' | 'warning' | 'success', duration?: number, action?: ToastAction) => void;
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

  // Federation approval-count badge (surfaced by MobileInstancePanel; kept fresh
  // by the FederationPanel via `onApprovalCountChange` whenever an admin
  // approves/denies a request from inside the panel)
  federationApprovalCount: number;
  setFederationApprovalCount: (count: number) => void;
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
        origin: '',
        anchor: null,
        placement: 'right',
        member: null,
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

      openUserProfile: (user, origin, anchor, placement = 'right', member) => {
        if (get().isMobile) {
          // On mobile, push a full-screen user profile instead of a positioned popout
          const params: Record<string, string> = { userId: user.id, origin };
          if (member) {
            params.spaceId = member.spaceId;
            params.memberUserId = member.userId;
          }
          set((state) => ({
            mobileStack: [...state.mobileStack, { screen: 'user-profile', params }],
          }));
          history.pushState({ mobileScreen: 'user-profile' }, '');
        } else {
          set({ userProfilePopout: { user, origin, anchor, placement, member: member ?? null } });
        }
      },
      closeUserProfile: () => set({
        userProfilePopout: { user: null, origin: '', anchor: null, placement: 'right', member: null }
      }),

      addToast: (message, type = 'info', duration = 5000, action) => {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
        set((state) => ({ toasts: [...state.toasts, { id, message, type, action }] }));
        // A duration of 0 means the toast stays until the viewer dismisses it.
        // An actionable toast that vanishes on a timer is worse than none: the
        // action is the whole point, and five seconds is not enough to notice a
        // toast, read it, and decide to click it.
        if (duration > 0) {
          setTimeout(() => {
            set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) }));
          }, duration);
        }
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

      federationApprovalCount: 0,
      setFederationApprovalCount: (count) => set({ federationApprovalCount: count }),
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
