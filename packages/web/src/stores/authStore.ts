import { create } from 'zustand';
import type { User, UserStatus } from '@backspace/shared';
import { api } from '../api/client';
import { useChatStore } from './chatStore';
import { useSpaceStore } from './spaceStore';
import { useSocialStore } from './socialStore';
import { useVoiceStore } from './voiceStore';
import { useInstanceStore } from './instanceStore';
import { syncProfileUpdateToRemotes } from '../utils/profileSync';
import { changePasswordOnRemotes, deleteAccountOnRemotes, type FederationOpResult } from '../utils/federationOps';

interface AuthState {
  token: string | null;
  user: User | null;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, displayName?: string, avatarColor?: string) => Promise<void>;
  logout: () => void;
  loadUser: () => Promise<void>;
  updateProfile: (data: { displayName?: string; avatar?: string; banner?: string; accentColor?: string; avatarColor?: string; bio?: string; customStatus?: string; status?: UserStatus }) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<FederationOpResult[]>;
  deleteAccount: (password: string, username: string) => Promise<void>;
  setUser: (user: User) => void;
  clearError: () => void;
}

/** Reset all user-scoped stores to prevent data leaking between sessions */
function resetUserStores() {
  useChatStore.getState().clearAllMessages();
  useSpaceStore.getState().populateFromReady('', [], [], []);
  useSocialStore.getState().reset();
  useVoiceStore.getState().resetSession();
  useInstanceStore.getState().reset();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('backspace_token'),
  user: null,
  isLoading: false,
  error: null,

  login: async (username: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.auth.login({ username, password });
      resetUserStores();
      localStorage.setItem('backspace_token', response.token);
      set({ token: response.token, user: response.user, isLoading: false });
      // Auto-connect to remote instances (fire-and-forget)
      useInstanceStore.getState().autoConnectAll().catch(() => {});
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Login failed' });
      throw err;
    }
  },

  register: async (username: string, password: string, displayName?: string, avatarColor?: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.auth.register({ username, password, displayName, avatarColor });
      resetUserStores();
      localStorage.setItem('backspace_token', response.token);
      set({ token: response.token, user: response.user, isLoading: false });
      // Auto-connect to remote instances (fire-and-forget)
      useInstanceStore.getState().autoConnectAll().catch(() => {});
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Registration failed' });
      throw err;
    }
  },

  logout: () => {
    localStorage.removeItem('backspace_token');
    resetUserStores();
    set({ token: null, user: null });
  },

  loadUser: async () => {
    const token = get().token;
    if (!token) return;

    set({ isLoading: true });
    try {
      const user = await api.users.me();
      set({ user, isLoading: false });
      // Auto-connect to remote instances (fire-and-forget)
      useInstanceStore.getState().autoConnectAll().catch(() => {});
    } catch {
      localStorage.removeItem('backspace_token');
      set({ token: null, user: null, isLoading: false });
    }
  },

  updateProfile: async (data) => {
    try {
      const user = await api.users.update(data);
      set({ user });
      // Push profile changes to all connected remote instances
      syncProfileUpdateToRemotes(data).catch((err) => {
        console.warn('[ProfileSync] Failed to sync to remotes:', err);
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Update failed' });
      throw err;
    }
  },

  changePassword: async (currentPassword: string, newPassword: string) => {
    // Change on home instance
    const response = await api.users.changePassword({ currentPassword, newPassword });

    // Update token in state and localStorage
    localStorage.setItem('backspace_token', response.token);
    set({ token: response.token });

    // Propagate to remote instances (best-effort)
    const remoteResults = await changePasswordOnRemotes(newPassword);
    return remoteResults;
  },

  deleteAccount: async (password: string, username: string) => {
    // Delete on all remote instances first (best-effort)
    await deleteAccountOnRemotes();

    // Delete on home instance
    await api.users.deleteAccount({ password, username });

    // Clear all state
    localStorage.removeItem('backspace_token');
    resetUserStores();
    set({ token: null, user: null });
  },

  setUser: (user: User) => set({ user }),

  clearError: () => set({ error: null }),
}));
