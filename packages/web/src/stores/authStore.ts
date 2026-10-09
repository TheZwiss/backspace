import { useChannelPokeStore } from '../components/chat/channelPokeStore';
import { useMemo } from 'react';
import { create } from 'zustand';
import { isChosenUserStatus, type ChosenUserStatus, type FederatedIdentity, type User } from '@backspace/shared';
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
import { useNotificationSettingsStore } from './notificationSettingsStore';
import { deleteAccountOnRemotes } from '../utils/federationOps';
import { homeHostOf, homeIdentityOf, isMine, ownRowAt, selfIdentityOf, type IdentityFields, type SelfIdentity } from '../utils/identity';
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
   * account, while that report is at most a day old (`seedTrueHomeStatus`).
   * Read through `myChosenStatus` (utils/selfStatus.ts), never directly.
   */
  trueHomeStatus: ChosenUserStatus | null;
  /**
   * origin → the signed-in user's row id on that connected instance, as its
   * `ready` named it. The page's own instance is not in it: its row is
   * `user`. The one record of "my ids"; read through `getMyUserIdForOrigin`,
   * `isMe` and `useSelfIdentity`.
   */
  myRowIds: ReadonlyMap<string, string>;
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
  /** A connected instance's `ready` named `userId` as the signed-in user's row there. */
  recordMyRow: (origin: string, userId: string) => void;
  /** The instance at `origin` was removed: its row id no longer says anything. */
  forgetMyRow: (origin: string) => void;
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
  useChatStore.getState().clearAllMessages();
  useSpaceStore.getState().reset();
  useChannelPokeStore.getState().reset();
  useSocialStore.getState().reset();
  useVoiceStore.getState().resetSession();
  useInstanceStore.getState().reset();
  useActivityStore.getState().reset();
  useExploreStore.getState().reset();
  useDirectoryStore.getState().reset();
  useNotificationSettingsStore.getState().reset();
  useSettingsStore.getState().resetUpdateState();
}

const TRUE_HOME_STATUS_KEY_PREFIX = 'backspace_true_home_status';

/**
 * How long a kept true-home report stands in for the true home. Past it the
 * choice is unknown until the true home reports: a Do Not Disturb kept from
 * days ago must not keep alerts silent after the user changed it elsewhere
 * (#325).
 */
export const TRUE_HOME_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** What is kept: the status the true home reported and when it did. */
interface KeptTrueHomeStatus {
  status: ChosenUserStatus;
  reportedAt: number;
}

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

function parseKeptStatus(stored: string | null): KeptTrueHomeStatus | null {
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== 'object' || value === null) return null;
    const { status, reportedAt } = value as Record<string, unknown>;
    if (!isChosenUserStatus(status) || typeof reportedAt !== 'number' || !Number.isFinite(reportedAt)) return null;
    return { status, reportedAt };
  } catch {
    // A value from before the report time was kept (a bare status) has no
    // age, so it cannot be trusted: unknown.
    return null;
  }
}

/**
 * The last report the true home made to this device, when it is at most
 * `TRUE_HOME_STATUS_MAX_AGE_MS` old; null otherwise (or when storage cannot be
 * read). Read through `seedTrueHomeStatus`.
 */
function lastTrueHomeStatus(user: User | null, now: number): KeptTrueHomeStatus | null {
  const key = trueHomeStatusStorageKey(user);
  if (!key) return null;
  try {
    const kept = parseKeptStatus(localStorage.getItem(key));
    if (!kept) return null;
    const age = now - kept.reportedAt;
    return age >= 0 && age <= TRUE_HOME_STATUS_MAX_AGE_MS ? kept : null;
  } catch {
    return null;
  }
}

/**
 * The pending clear of a `trueHomeStatus` that was started from a kept report.
 * Set only while the value in the store is that kept report; the true home's
 * live report, a new session and signing out cancel it.
 */
let keptStatusExpiry: ReturnType<typeof setTimeout> | null = null;

function cancelKeptStatusExpiry(): void {
  if (keptStatusExpiry === null) return;
  clearTimeout(keptStatusExpiry);
  keptStatusExpiry = null;
}

/**
 * The `trueHomeStatus` a session of `user` starts from: the kept report while
 * it is at most `TRUE_HOME_STATUS_MAX_AGE_MS` old, else null. A kept report
 * stands in only until it reaches that age, also while the page stays open:
 * the clear is scheduled for the moment it does, and the true home's live
 * report (`applyOwnStatus`) cancels it, since from then on the value is not
 * the kept one (activity-presence.md, "The client's copy of the user's own
 * status").
 */
function seedTrueHomeStatus(user: User | null): ChosenUserStatus | null {
  cancelKeptStatusExpiry();
  const now = Date.now();
  const kept = lastTrueHomeStatus(user, now);
  if (!kept) return null;
  // One past the last millisecond at which the report still stands in.
  const delay = kept.reportedAt + TRUE_HOME_STATUS_MAX_AGE_MS + 1 - now;
  keptStatusExpiry = setTimeout(() => {
    keptStatusExpiry = null;
    useAuthStore.setState({ trueHomeStatus: null });
  }, delay);
  return kept.status;
}

function rememberTrueHomeStatus(user: User | null, status: ChosenUserStatus): void {
  const key = trueHomeStatusStorageKey(user);
  if (!key) return;
  const kept: KeptTrueHomeStatus = { status, reportedAt: Date.now() };
  try {
    localStorage.setItem(key, JSON.stringify(kept));
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
  myRowIds: new Map(),
  isLoading: false,
  error: null,

  initSession: (token: string, user: User) => {
    resetUserStores();
    localStorage.setItem('backspace_token', token);
    set({ token, user, trueHomeStatus: seedTrueHomeStatus(user), myRowIds: new Map(), isLoading: false });
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
    cancelKeptStatusExpiry();
    set({ token: null, user: null, trueHomeStatus: null, myRowIds: new Map() });
  },

  loadUser: async () => {
    const token = get().token;
    if (!token) return;

    set({ isLoading: true });
    try {
      const user = await api.users.me();
      // A value already in the page (the true home's report, or the kept
      // report a sign-in started from, with its expiry) is kept as it is.
      set({ user, trueHomeStatus: get().trueHomeStatus ?? seedTrueHomeStatus(user), isLoading: false });
      // Auto-connect to remote instances (fire-and-forget)
      useInstanceStore.getState().autoConnectAll().catch(() => {});
    } catch {
      localStorage.removeItem('backspace_token');
      cancelKeptStatusExpiry();
      set({ token: null, user: null, trueHomeStatus: null, myRowIds: new Map(), isLoading: false });
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
    cancelKeptStatusExpiry();
    set({ token: null, user: null, trueHomeStatus: null, myRowIds: new Map() });
  },

  setUser: (user: User) => set({ user }),

  recordMyRow: (origin, userId) => {
    if (!origin || get().myRowIds.get(origin) === userId) return;
    const myRowIds = new Map(get().myRowIds);
    myRowIds.set(origin, userId);
    set({ myRowIds });
  },

  forgetMyRow: (origin) => {
    if (!get().myRowIds.has(origin)) return;
    const myRowIds = new Map(get().myRowIds);
    myRowIds.delete(origin);
    set({ myRowIds });
  },

  applyOwnStatus: ({ owner, status }) => {
    if (owner === 'trueHome') {
      cancelKeptStatusExpiry();
      rememberTrueHomeStatus(get().user, status);
      if (get().trueHomeStatus !== status) set({ trueHomeStatus: status });
      return;
    }
    const user = get().user;
    if (user && user.status !== status) set({ user: { ...user, status } });
  },

  clearError: () => set({ error: null }),
}));

// ─── The signed-in user's rows ───────────────────────────────────────────────

/** Reactive `selfIdentityOf` for the current session. */
export function useSelfIdentity(): SelfIdentity | null {
  const user = useAuthStore((s) => s.user);
  const myRowIds = useAuthStore((s) => s.myRowIds);
  return useMemo(() => selfIdentityOf(user, myRowIds), [user, myRowIds]);
}

/** Whether `row`, as `origin` issued it, is the signed-in user (`isMine`). */
export function isMe(row: IdentityFields, origin: string): boolean {
  const { user, myRowIds } = useAuthStore.getState();
  return isMine(row, origin, selfIdentityOf(user, myRowIds));
}

/**
 * Whether a federated identity on the wire (a home user id and the instance
 * that homes it) is the signed-in user, compared by home identity, never by
 * a row id.
 */
export function isMyIdentity(identity: FederatedIdentity): boolean {
  const { user } = useAuthStore.getState();
  const self = user ? homeIdentityOf(user, '') : null;
  if (!self) return false;
  return self.userId === identity.homeUserId && homeHostOf(self.host) === homeHostOf(identity.homeInstance);
}

/**
 * The signed-in user's row id on the instance at `origin` ('' = the page's
 * own), or undefined while that instance's `ready` has not named it.
 */
export function getMyUserIdForOrigin(origin: string): string | undefined {
  const { user, myRowIds } = useAuthStore.getState();
  if (!origin) return user?.id;
  return myRowIds.get(origin);
}


/**
 * The signed-in user's row as the instance at `origin` issues it
 * (`ownRowAt`), for rows the client makes up before that instance sends its
 * own: the session row itself for `''`, else the session row under the id
 * that instance's `ready` gave the user. Null when signed out or while that
 * instance has not named the user's row: the session row's id means someone
 * else there.
 */
export function myRowFor(user: User | null, myRowIds: ReadonlyMap<string, string>, origin: string): User | null {
  if (!user) return null;
  if (!origin) return user;
  const rowId = myRowIds.get(origin);
  return rowId ? ownRowAt(user, origin, rowId) : null;
}

/** `myRowFor` the current session, read once. */
export function myRowForOrigin(origin: string): User | null {
  const { user, myRowIds } = useAuthStore.getState();
  return myRowFor(user, myRowIds, origin);
}

/** Reactive `myRowForOrigin`. */
export function useMyRowForOrigin(origin: string): User | null {
  const user = useAuthStore((s) => s.user);
  const myRowIds = useAuthStore((s) => s.myRowIds);
  return useMemo(() => myRowFor(user, myRowIds, origin), [user, myRowIds, origin]);
}
