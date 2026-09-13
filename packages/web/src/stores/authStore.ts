import { create } from 'zustand';
import type { User, UserStatus } from '@backspace/shared';
import { api } from '../api/client';
import { useChatStore } from './chatStore';
import { useSpaceStore } from './spaceStore';
import { useSocialStore } from './socialStore';
import { useVoiceStore } from './voiceStore';
import { useInstanceStore } from './instanceStore';
import { useActivityStore } from './activityStore';
import { changePasswordOnRemotes, deleteAccountOnRemotes, type FederationOpResult } from '../utils/federationOps';
import { clearSelfIds } from '../utils/identity';

interface AuthState {
  token: string | null;
  user: User | null;
  isLoading: boolean;
  error: string | null;
  /** Username + password held between the two login steps when 2FA is required. */
  pending2fa: { username: string; password: string } | null;
  initSession: (token: string, user: User) => void;
  login: (username: string, password: string) => Promise<void>;
  /**
   * Second step of the login flow. Call after `login()` resolves with
   * `{ requires2fa: true }`. Re-submits username + password + code to the
   * server. Throws if no pending 2FA is queued.
   */
  loginStep2: (code: string) => Promise<void>;
  /** Aborts the 2FA challenge (e.g. user clicks Cancel in the prompt). */
  cancel2fa: () => void;
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
  clearSelfIds();
  useChatStore.getState().clearAllMessages();
  useSpaceStore.getState().reset();
  useSocialStore.getState().reset();
  useVoiceStore.getState().resetSession();
  useInstanceStore.getState().reset();
  useActivityStore.getState().reset();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('backspace_token'),
  user: null,
  isLoading: false,
  error: null,
  pending2fa: null,

  initSession: (token: string, user: User) => {
    resetUserStores();
    localStorage.setItem('backspace_token', token);
    set({ token, user, isLoading: false, pending2fa: null });
    useInstanceStore.getState().autoConnectAll().catch(() => {});
  },

  login: async (username: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.auth.login({ username, password });
      // Discriminated union — server returns either AuthResponse or
      // { requires2fa: true }. The latter must NOT be treated as success.
      if ('requires2fa' in response && response.requires2fa === true) {
        set({ isLoading: false, pending2fa: { username, password } });
        return;
      }
      // After the guard above, TypeScript still sees the union; narrow by
      // asserting the shape via the absence of the discriminator.
      const auth = response as Exclude<typeof response, { requires2fa: true }>;
      get().initSession(auth.token, auth.user);
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Login failed' });
      throw err;
    }
  },

  loginStep2: async (code: string) => {
    const pending = get().pending2fa;
    if (!pending) {
      throw new Error('No 2FA challenge in progress');
    }
    set({ isLoading: true, error: null });
    try {
      const response = await api.auth.login({
        username: pending.username,
        password: pending.password,
        code: code.trim(),
      });
      if ('requires2fa' in response && response.requires2fa === true) {
        // Still wrong — server returned 2FA-again (shouldn't happen unless
        // our session was wrong; surface as a generic error rather than
        // re-entering the challenge).
        set({ isLoading: false, error: 'Invalid 2FA code' });
        throw new Error('Invalid 2FA code');
      }
      const auth = response as Exclude<typeof response, { requires2fa: true }>;
      get().initSession(auth.token, auth.user);
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Login failed' });
      throw err;
    }
  },

  cancel2fa: () => {
    set({ pending2fa: null, error: null, isLoading: false });
  },

  register: async (username: string, password: string, displayName?: string, avatarColor?: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.auth.register({ username, password, displayName, avatarColor });
      get().initSession(response.token, response.user);
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Registration failed' });
      throw err;
    }
  },

  logout: () => {
    localStorage.removeItem('backspace_token');
    resetUserStores();
    set({ token: null, user: null, pending2fa: null });
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
