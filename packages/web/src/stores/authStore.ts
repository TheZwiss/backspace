import { useChannelActivityStore } from './channelActivityStore';
import { useNotificationStore } from './notificationStore';
import { create } from 'zustand';
import { isChosenUserStatus, type ChosenUserStatus, type User } from '@backspace/shared';
import { api } from '../api/client';
import { useChatStore } from './chatStore';
import { useSpaceStore } from './spaceStore';
import { useSocialStore } from './socialStore';
import { useVoiceStore } from './voiceStore';
import { useInstanceStore, resolveSessionApiForHome } from './instanceStore';
import { useActivityStore } from './activityStore';
import { useSettingsStore } from './settingsStore';
import { useExploreStore } from './exploreStore';
import { useDirectoryStore } from './directoryStore';
import { deleteAccountOnRemotes } from '../utils/federationOps';
import { clearSelfIds } from '../utils/identity';
import { myChosenStatus, statusAuthority, type OwnStatusReport } from '../utils/selfStatus';
import i18n from '../i18n';

interface AuthState {
  token: string | null;
  user: User | null;
  /**
   * The chosen status as the true home last reported it, when the session
   * account is a replicated row (`statusAuthority(user).kind === 'trueHome'`);
   * null otherwise or while unknown. Until the true home's first report in
   * this page it holds the last report this device kept for the same home
   * account (`lastTrueHomeStatus`). Read through `myChosenStatus`
   * (utils/selfStatus.ts), never directly.
   */
  trueHomeStatus: ChosenUserStatus | null;
  isLoading: boolean;
  error: string | null;
  initSession: (token: string, user: User) => void;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, displayName?: string, avatarColor?: string) => Promise<void>;
  logout: () => void;
  loadUser: () => Promise<void>;
  updateProfile: (data: { displayName?: string; avatar?: string; banner?: string; accentColor?: string; avatarColor?: string; bio?: string; customStatus?: string; status?: ChosenUserStatus }) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  deleteAccount: (password: string, username: string) => Promise<void>;
  setUser: (user: User) => void;
  /** Apply the owner's own report of the user's status (`ownStatusReport`). */
  applyOwnStatus: (report: OwnStatusReport) => void;
  clearError: () => void;
}

/**
 * Reset all user-scoped stores to prevent data leaking between sessions.
 *
 * `exploreStore` is in this list because `myRequests` holds the signed-in
 * user's own pending join requests: without the call, signing in as someone
 * else showed the previous account's rows until the new session's first
 * fan-out replaced them, and "Request Pending" on a card is a statement about
 * whoever is signed in now. Its `spaces` are a discoverable list rather than
 * private data, but they are one account's view of it, assembled from the
 * instances that account was connected to.
 *
 * `directoryStore` is in it because the feed it holds is fetched through the
 * home instance's proxy as the signed-in user, and because both stores' own
 * `reset()` bump the sequence counters that orphan a fan-out still in flight
 * when the session ends. Leaving either out meant a reply for the old session
 * could land in the new one.
 */
function resetUserStores() {
  clearSelfIds();
  useChatStore.getState().clearAllMessages();
  useSpaceStore.getState().reset();
  useNotificationStore.getState().reset();
  useChannelActivityStore.getState().reset();
  useSocialStore.getState().reset();
  useVoiceStore.getState().resetSession();
  useInstanceStore.getState().reset();
  useActivityStore.getState().reset();
  useExploreStore.getState().reset();
  useDirectoryStore.getState().reset();
  useSettingsStore.getState().resetUpdateState();
}

const TRUE_HOME_STATUS_KEY_PREFIX = 'backspace_true_home_status';

/**
 * Where this device keeps the last status a true home reported, keyed by the
 * home account (host and user id there), so every session of that account on
 * any instance starts from it. Null for a session that owns its own choice.
 */
function trueHomeStatusStorageKey(user: User | null): string | null {
  const authority = statusAuthority(user);
  if (authority?.kind !== 'trueHome') return null;
  return `${TRUE_HOME_STATUS_KEY_PREFIX}:${authority.host}:${authority.userId}`;
}

/**
 * The last status the true home reported to this device, or null when there is
 * none (or storage cannot be read). It stands in until the true home's first
 * report in this page arrives, so Do Not Disturb holds from page load instead
 * of from the moment the home connection is up (activity-presence.md, "The
 * client's copy of the user's own status").
 */
function lastTrueHomeStatus(user: User | null): ChosenUserStatus | null {
  const key = trueHomeStatusStorageKey(user);
  if (!key) return null;
  try {
    const stored = localStorage.getItem(key);
    return isChosenUserStatus(stored) ? stored : null;
  } catch {
    return null;
  }
}

function rememberTrueHomeStatus(user: User | null, status: ChosenUserStatus): void {
  const key = trueHomeStatusStorageKey(user);
  if (!key) return;
  try {
    localStorage.setItem(key, status);
  } catch {
    // Storage unavailable (private window, quota): the next page load starts
    // unknown until the true home reports, as it did before this was kept.
  }
}

/**
 * The user's chosen status, from whichever account owns it (utils/selfStatus.ts).
 * The one read used by the alert gate, the ringing loop and the settings panel.
 */
export function selectMyChosenStatus(state: Pick<AuthState, 'user' | 'trueHomeStatus'>): ChosenUserStatus | null {
  return myChosenStatus(state.user, state.trueHomeStatus);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('backspace_token'),
  user: null,
  trueHomeStatus: null,
  isLoading: false,
  error: null,

  initSession: (token: string, user: User) => {
    resetUserStores();
    localStorage.setItem('backspace_token', token);
    set({ token, user, trueHomeStatus: lastTrueHomeStatus(user), isLoading: false });
    useInstanceStore.getState().autoConnectAll().catch(() => {});
  },

  login: async (username: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.auth.login({ username, password });
      get().initSession(response.token, response.user);
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Login failed' });
      throw err;
    }
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
    set({ token: null, user: null, trueHomeStatus: null });
  },

  loadUser: async () => {
    const token = get().token;
    if (!token) return;

    set({ isLoading: true });
    try {
      const user = await api.users.me();
      // A report the true home already made in this page is newer than the kept one.
      set({ user, trueHomeStatus: get().trueHomeStatus ?? lastTrueHomeStatus(user), isLoading: false });
      // Auto-connect to remote instances (fire-and-forget)
      useInstanceStore.getState().autoConnectAll().catch(() => {});
    } catch {
      localStorage.removeItem('backspace_token');
      set({ token: null, user: null, trueHomeStatus: null, isLoading: false });
    }
  },

  updateProfile: async (data) => {
    try {
      // The status goes to the account that owns the choice: this session's
      // own instance, or the true home when this session is a replicated row
      // (activity-presence.md, "The client's copy of the user's own status").
      const { status, ...profile } = data;
      const authority = statusAuthority(get().user);
      if (status !== undefined && authority?.kind === 'trueHome') {
        const home = resolveSessionApiForHome(authority.host);
        if (!home) throw new Error(i18n.t('settings:account.details.status.homeUnavailable', { host: authority.host }));
        const homeUser = await home.api.users.update({ status });
        get().applyOwnStatus({ owner: 'trueHome', status: isChosenUserStatus(homeUser.status) ? homeUser.status : status });
      }
      const pageUpdate = authority?.kind === 'trueHome' ? profile : data;
      if (Object.keys(pageUpdate).length > 0) {
        const user = await api.users.update(pageUpdate);
        set({ user });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Update failed' });
      throw err;
    }
  },

  changePassword: async (currentPassword: string, newPassword: string) => {
    // Change on this instance only. Remote instances are NOT touched: each
    // federated account authenticates with its own home-issued per-remote
    // secret, so the home password is not a credential anywhere else and there
    // is nothing to propagate (client-federation.md §1).
    const response = await api.users.changePassword({ currentPassword, newPassword });

    // Update token in state and localStorage
    localStorage.setItem('backspace_token', response.token);
    set({ token: response.token });
  },

  deleteAccount: async (password: string, username: string) => {
    // Delete on all remote instances first (best-effort)
    await deleteAccountOnRemotes();

    // Delete on home instance
    await api.users.deleteAccount({ password, username });

    // Clear all state
    localStorage.removeItem('backspace_token');
    resetUserStores();
    set({ token: null, user: null, trueHomeStatus: null });
  },

  setUser: (user: User) => set({ user }),

  applyOwnStatus: ({ owner, status }) => {
    if (owner === 'trueHome') {
      rememberTrueHomeStatus(get().user, status);
      if (get().trueHomeStatus !== status) set({ trueHomeStatus: status });
      return;
    }
    const user = get().user;
    if (user && user.status !== status) set({ user: { ...user, status } });
  },

  clearError: () => set({ error: null }),
}));
