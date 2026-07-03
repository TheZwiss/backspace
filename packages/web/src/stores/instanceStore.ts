import { create } from 'zustand';
import type { User, InstanceInfoResponse, ReplicatedInstance, AuthResponse, FederationRegistryEntry } from '@backspace/shared';
import { BackspaceApiClient, createApiClient, api } from '../api/client';
import { useAuthStore } from './authStore';
import {
  setApiForOriginResolver,
  setUserIdForOriginResolver,
  setOriginFromHostnameResolver,
  setTokenForOriginResolver,
} from '../utils/crossStoreResolvers';
import { useSpaceStore } from './spaceStore';
import { connectInstance, disconnectInstance as disconnectWs, disconnectAllRemote } from '../hooks/useWebSocket';
// Circular dependency: federationOps imports useInstanceStore, instanceStore imports this.
// Safe because both modules access each other lazily (at call time, not import time).
// clearPasswordSyncTimers itself does not reference useInstanceStore.
import { clearPasswordSyncTimers } from '../utils/federationOps';
// dmOriginFailover lazily reads useInstanceStore/useSpaceStore/useChatStore at call time,
// so a static import here does not create an import-time cycle.
import { failoverDmOriginsFromDisconnected } from '../utils/dmOriginFailover';
import { useUIStore } from './uiStore';
import { parseFederatedUsername } from '../utils/identity';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConnectedInstance {
  origin: string;
  label: string;
  token: string;
  user: User;
  username: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  error?: string;
  api: BackspaceApiClient;
}

interface CachedInstanceToken {
  token: string;
  label: string;
  username: string;
  pendingPasswordSync?: boolean;
}

const STORAGE_KEY_PREFIX = 'backspace_instances';
const LEGACY_STORAGE_KEY = 'backspace_instances';

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}_${userId}`;
}

// ─── localStorage helpers ────────────────────────────────────────────────────

function loadCachedTokens(userId: string): Record<string, CachedInstanceToken> {
  try {
    const scopedKey = storageKey(userId);
    const raw = localStorage.getItem(scopedKey);
    if (raw) {
      return JSON.parse(raw) as Record<string, CachedInstanceToken>;
    }

    // One-time migration: adopt legacy unscoped key if it exists
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as Record<string, CachedInstanceToken>;
      localStorage.setItem(scopedKey, legacy);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return parsed;
    }

    return {};
  } catch {
    return {};
  }
}

function saveCachedTokens(instances: ConnectedInstance[], userId: string, pendingSyncFlags?: Record<string, boolean>): void {
  const cache: Record<string, CachedInstanceToken> = {};
  // Load existing cache to preserve pendingPasswordSync flags
  const existing = loadCachedTokens(userId);
  for (const inst of instances) {
    // Skip tokenless placeholders — writing an empty token would cause
    // autoConnectAll to find a truthy cached entry with an empty bearer token
    if (!inst.token) continue;
    cache[inst.origin] = {
      token: inst.token,
      label: inst.label,
      username: inst.username,
      pendingPasswordSync: pendingSyncFlags?.[inst.origin] ?? existing[inst.origin]?.pendingPasswordSync,
    };
  }
  localStorage.setItem(storageKey(userId), JSON.stringify(cache));
}

// ─── Network error detection ────────────────────────────────────────────────

/** Detect network-level failures (unreachable, DNS, timeout) vs application errors (401, etc.) */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError ||
    (err instanceof Error && /fetch|network|ECONNREFUSED|ETIMEDOUT/i.test(err.message));
}

// ─── Error types ────────────────────────────────────────────────────────────

/** Thrown when the remote instance already has an account for this user with a different password. */
export class DifferentPasswordError extends Error {
  constructor(public remoteUsername: string) {
    super('Account exists with a different password on this instance');
    this.name = 'DifferentPasswordError';
  }
}

// ─── URL normalization ───────────────────────────────────────────────────────

function normalizeOrigin(url: string): string {
  let normalized = url.trim();

  // Add https:// if no protocol
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    return parsed.origin; // "https://domain.com" — no path, no trailing slash
  } catch {
    throw new Error('Invalid URL');
  }
}

/** Check whether an origin string refers to the current (home) instance. */
export function isSelfOrigin(origin: string): boolean {
  try {
    return normalizeOrigin(origin) === window.location.origin;
  } catch {
    return false;
  }
}

// ─── Automatic re-attach (re-attach spec §3.4) ────────────────────────────────

/**
 * Automatic re-attach (re-attach spec §3.4): when a just-connected remote
 * account is DETACHED and this client also holds an authenticated session on
 * the account's home domain under the SAME username base, silently perform
 * the proof exchange — the user has proven both identities, so the accounts
 * re-link without interaction. Cross-name binds and every ambiguous case fall
 * through to the explicit AccountPanel action. Fire-and-forget, non-fatal.
 */
export async function maybeAutoReattach(instance: ConnectedInstance): Promise<void> {
  const remoteUser = instance.user;
  if (!remoteUser.federationHomeOrphaned || !remoteUser.homeInstance) return;
  const homeDomain = remoteUser.homeInstance.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();

  // An authenticated session on the account's home domain: the primary
  // connection when we're browsing it, else a connected secondary instance.
  const primaryUser = useAuthStore.getState().user;
  let homeApi: BackspaceApiClient | null = null;
  let homeUsername: string | null = null;
  if (primaryUser && !primaryUser.homeInstance && window.location.host.toLowerCase() === homeDomain) {
    homeApi = api;
    homeUsername = primaryUser.username;
  } else {
    const conn = useInstanceStore.getState().instances.find(
      (i) => i.status === 'connected' && new URL(i.origin).host.toLowerCase() === homeDomain,
    );
    if (conn) {
      homeApi = conn.api;
      homeUsername = conn.username;
    }
  }
  if (!homeApi || !homeUsername) return;

  // Unambiguous case only: same username base on both sides (spec §2/§3.4).
  const detachedBase = parseFederatedUsername(remoteUser.username).baseName.toLowerCase();
  const homeBase = parseFederatedUsername(homeUsername).baseName.toLowerCase();
  if (!detachedBase || detachedBase !== homeBase) return;

  try {
    const targetHost = new URL(instance.origin).host;
    const { token } = await homeApi.auth.attachProof(targetHost);
    const res = await instance.api.users.reattach({ token });
    useInstanceStore.setState((state) => ({
      instances: state.instances.map((i) =>
        i.origin === instance.origin ? { ...i, user: res.user, username: res.user.username } : i,
      ),
    }));
    // Registry mirrors the connection's identity — keep the re-bound username in sync.
    const registry = upsertRegistryEntry(useInstanceStore.getState().registry, instance.origin, {
      origin: instance.origin,
      username: res.user.username,
      remoteUserId: res.user.id,
    });
    useInstanceStore.setState({ registry, registryUpdatedAt: Date.now() });
    useUIStore.getState().addToast(`Account re-linked with ${homeDomain}`, 'success');
    useInstanceStore.getState().syncRegistry().catch(() => {});
  } catch (err) {
    // Non-fatal: the connection works either way; the explicit re-attach
    // action in AccountPanel remains available.
    console.warn('[federation] Auto re-attach failed:', err);
  }
}

// ─── API client resolution ───────────────────────────────────────────────────

// ─── Registry helpers ────────────────────────────────────────────────────────

function upsertRegistryEntry(
  registry: Map<string, FederationRegistryEntry>,
  origin: string,
  updates: Partial<FederationRegistryEntry> & { origin: string },
): Map<string, FederationRegistryEntry> {
  const next = new Map(registry);
  const existing = next.get(origin);
  if (existing) {
    next.set(origin, { ...existing, ...updates });
  } else {
    next.set(origin, {
      label: '',
      username: '',
      remoteUserId: '',
      status: 'connected',
      addedAt: Date.now(),
      lastConnectedAt: null,
      disconnectedAt: null,
      errorMessage: null,
      ...updates,
    });
  }
  return next;
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface InstanceState {
  instances: ConnectedInstance[];
  isLoading: boolean;
  error: string | null;
  _autoConnectDone: boolean;
  pendingSyncOrigins: string[];
  registry: Map<string, FederationRegistryEntry>;
  registryUpdatedAt: number;
  // True once we've successfully fetched the authoritative registry from the
  // home server at least once this session. Until then, syncRegistry() must
  // not PUT — our local view is incomplete and would clobber server state.
  _registrySyncReady: boolean;
  syncRegistry: () => Promise<void>;
  deleteIdentity: (origins: string[], mode?: 'leave' | 'soft' | 'full') => Promise<Record<string, { success: boolean; error?: string; ownedSpaces?: { id: string; name: string }[] }>>;
  forceRemoveEntry: (origin: string) => void;

  probeInstance: (url: string) => Promise<InstanceInfoResponse & { origin: string }>;
  connectToRemote: (origin: string, password: string, displayName?: string) => Promise<void>;
  loginToRemote: (origin: string, username: string, password: string) => Promise<void>;
  disconnectInstance: (origin: string) => void;
  setInstanceStatus: (origin: string, status: ConnectedInstance['status'], error?: string) => void;
  reconnectInstance: (origin: string) => Promise<void>;
  reauthenticateInstance: (origin: string, password: string) => Promise<void>;
  updateInstanceToken: (origin: string, newToken: string) => void;
  setPendingPasswordSync: (origin: string, pending: boolean) => void;
  hasPendingPasswordSync: (origin: string) => boolean;
  syncInstanceList: () => Promise<void>;
  autoConnectAll: () => Promise<void>;
  reset: () => void;
}

export const useInstanceStore = create<InstanceState>((set, get) => ({
  instances: [],
  isLoading: false,
  error: null,
  _autoConnectDone: false,
  pendingSyncOrigins: [],
  registry: new Map(),
  registryUpdatedAt: 0,
  _registrySyncReady: false,

  probeInstance: async (url: string) => {
    const origin = normalizeOrigin(url);

    // Reject self-connection
    if (isSelfOrigin(url)) {
      throw new Error("You're already logged into this instance");
    }

    // Reject duplicates — but only if already connected/connecting.
    // Allow re-adding instances that are in error/disconnected state.
    const existing = get().instances.find(i => i.origin === origin);
    if (existing && (existing.status === 'connected' || existing.status === 'connecting')) {
      throw new Error('This instance is already connected');
    }

    // Probe with unauthenticated client
    const tempClient = createApiClient(origin, () => null);
    const info = await tempClient.instance.info();

    return { ...info, origin };
  },

  connectToRemote: async (origin: string, password: string, displayName?: string) => {
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) throw new Error('Not logged in');

    set({ isLoading: true, error: null });

    try {
      // Step 1: Verify password against the instance we're currently browsing
      const { valid } = await api.users.verifyPassword(password);
      if (!valid) {
        throw new Error('Incorrect password');
      }

      // Step 2: Compute the user's true home identity
      // If we're a federated user (e.g. erin@nova browsing orbit),
      // homeInstance points to the real home, not window.location.host.
      const trueHomeHost = currentUser.homeInstance ?? window.location.host;
      const bareUsername = currentUser.username.includes('@')
        ? currentUser.username.split('@')[0]!
        : currentUser.username;
      const trueHomeUserId = currentUser.homeUserId ?? currentUser.id;
      const targetHost = new URL(origin).host;
      const targetIsHome = targetHost === trueHomeHost;

      const tempClient = createApiClient(origin, () => null);

      let response: AuthResponse | null = null;
      let finalUsername: string;

      if (targetIsHome) {
        // Target IS the user's home instance — they already have a native account.
        // Just login with bare username, no registration or homeInstance params.
        finalUsername = bareUsername;
        try {
          response = await tempClient.auth.login({
            username: bareUsername,
            password,
          });
        } catch {
          throw new DifferentPasswordError(bareUsername);
        }
      } else {
        // Target is a remote/third-party instance — register as user@homeHost
        finalUsername = `${bareUsername}@${trueHomeHost}`;

        // 2a: Attempt registration with namespaced username
        try {
          response = await tempClient.auth.register({
            username: finalUsername,
            password,
            displayName: displayName || currentUser.displayName || undefined,
            homeInstance: trueHomeHost,
            homeUserId: trueHomeUserId,
          });
        } catch (err) {
          const message = (err as Error).message;
          if (message.includes('already taken') || message.includes('409') ||
              message.includes('Registration is currently closed') || message.includes('403')) {
            // Already registered or registration closed — fall through to login
          } else {
            throw err;
          }
        }

        // 2b: If registration didn't work, try login
        if (!response) {
          try {
            response = await tempClient.auth.login({
              username: finalUsername,
              password,
            });
          } catch {
            // Namespaced login failed — try legacy plain username as fallback
            try {
              response = await tempClient.auth.login({
                username: bareUsername,
                password,
              });
            } catch {
              throw new DifferentPasswordError(bareUsername);
            }
          }
        }
      }

      if (!response) {
        throw new Error('Failed to authenticate with remote instance');
      }

      // Step 3: Complete connection
      const info = await tempClient.instance.info();
      const authenticatedClient = createApiClient(origin, () => response.token);

      const instance: ConnectedInstance = {
        origin,
        label: info.name,
        token: response.token,
        user: response.user,
        username: finalUsername,
        status: 'connected',
        api: authenticatedClient,
      };

      set((state) => {
        const updated = [...state.instances, instance];
        saveCachedTokens(updated, currentUser.id);
        return { instances: updated, isLoading: false };
      });

      // Upsert registry entry for the new connection
      const registry = upsertRegistryEntry(get().registry, origin, {
        origin,
        label: instance.label,
        username: instance.username,
        remoteUserId: instance.user.id,
        status: 'connected',
        addedAt: get().registry.get(origin)?.addedAt ?? Date.now(),
        lastConnectedAt: Date.now(),
        disconnectedAt: null,
        errorMessage: null,
      });
      const registryUpdatedAt = Date.now();
      set({ registry, registryUpdatedAt });

      // Open WebSocket connection to the remote instance
      connectInstance(origin, response.token);

      // Automatic re-attach for detached accounts (re-attach spec §3.4).
      maybeAutoReattach(instance).catch(() => {});

      // Ensure server-to-server peering for DM relay (non-fatal)
      try {
        const peerResult = await api.federation.ensurePeered({ remoteOrigin: origin });
        if (peerResult.peeringStatus === 'rejected') {
          const { addToast } = useUIStore.getState();
          addToast(
            `Cross-instance messaging unavailable — ${instance.label} requires manual peering approval`,
            'warning',
            10000,
          );
        } else if (peerResult.peeringStatus === 'pending') {
          const { addToast } = useUIStore.getState();
          addToast(
            `Peering with ${instance.label} in progress — cross-instance messaging will be available shortly`,
            'info',
          );
        }
      } catch (err) {
        console.warn('[federation] Peering attempt failed (non-fatal):', err);
      }

      // Sync instance list to all instances (fire-and-forget)
      get().syncInstanceList().catch(() => {});
      get().syncRegistry().catch(() => {});
    } catch (err) {
      set({ isLoading: false, error: (err as Error).message });
      throw err;
    }
  },

  loginToRemote: async (origin: string, username: string, password: string) => {
    set({ isLoading: true, error: null });

    try {
      const tempClient = createApiClient(origin, () => null);
      const response = await tempClient.auth.login({ username, password });

      // Fetch instance info for the label
      const info = await tempClient.instance.info();

      const authenticatedClient = createApiClient(origin, () => response.token);

      const instance: ConnectedInstance = {
        origin,
        label: info.name,
        token: response.token,
        user: response.user,
        username: response.user.username,
        status: 'connected',
        api: authenticatedClient,
      };

      set((state) => {
        const updated = [...state.instances, instance];
        const userId = useAuthStore.getState().user?.id;
        if (userId) saveCachedTokens(updated, userId);
        return { instances: updated, isLoading: false };
      });

      // Upsert registry entry for the login connection
      const registry = upsertRegistryEntry(get().registry, origin, {
        origin,
        label: instance.label,
        username: instance.username,
        remoteUserId: instance.user.id,
        status: 'connected',
        addedAt: get().registry.get(origin)?.addedAt ?? Date.now(),
        lastConnectedAt: Date.now(),
        disconnectedAt: null,
        errorMessage: null,
      });
      const registryUpdatedAt = Date.now();
      set({ registry, registryUpdatedAt });

      // Open WebSocket connection to the remote instance
      connectInstance(origin, response.token);

      // Automatic re-attach for detached accounts (re-attach spec §3.4).
      maybeAutoReattach(instance).catch(() => {});

      // Sync instance list to all instances (fire-and-forget)
      get().syncInstanceList().catch(() => {});
      get().syncRegistry().catch(() => {});
    } catch (err) {
      set({ isLoading: false, error: (err as Error).message });
      throw err;
    }
  },

  setInstanceStatus: (origin, status, error) => {
    const prev = get().instances.find(i => i.origin === origin)?.status;
    set((state) => ({
      instances: state.instances.map(i =>
        i.origin === origin ? { ...i, status, error } : i
      ),
    }));
    if (prev === 'connected' && (status === 'disconnected' || status === 'error')) {
      failoverDmOriginsFromDisconnected(origin);
    }
  },

  disconnectInstance: (origin: string) => {
    // Tear down WebSocket connection (stops auto-reconnect)
    disconnectWs(origin);

    // Update registry entry to disconnected
    const registry = upsertRegistryEntry(get().registry, origin, {
      origin,
      status: 'disconnected',
      disconnectedAt: Date.now(),
      errorMessage: null,
    });
    const registryUpdatedAt = Date.now();

    // Keep the instance in the array with status 'disconnected' — preserves
    // the token and API client so reconnect is instant (no re-auth needed).
    set((state) => {
      const updated = state.instances.map(i =>
        i.origin === origin ? { ...i, status: 'disconnected' as const, error: undefined } : i
      );
      const userId = useAuthStore.getState().user?.id;
      if (userId) saveCachedTokens(updated, userId);
      return { instances: updated, registry, registryUpdatedAt };
    });

    // Failover DMs to a connected sibling BEFORE removeInstanceSpaces wipes
    // this origin's pins. DMs with a connected alternative survive via rekey;
    // DMs without one are removed alongside the rest of the instance's content.
    failoverDmOriginsFromDisconnected(origin);
    useSpaceStore.getState().removeInstanceSpaces(origin);

    // Sync updated lists to remaining instances (fire-and-forget)
    get().syncInstanceList().catch(() => {});
    get().syncRegistry().catch(() => {});
  },

  reconnectInstance: async (origin: string) => {
    let inst = get().instances.find(i => i.origin === origin);

    // If the instance was disconnected (removed from active instances array) but
    // has a cached token in localStorage, restore it so reconnect can proceed.
    if (!inst) {
      const userId = useAuthStore.getState().user?.id;
      if (!userId) return;
      const cached = loadCachedTokens(userId);
      const entry = cached[origin];
      if (!entry?.token) return; // No cached token — needs full re-authentication via connectToRemote

      const currentUser = useAuthStore.getState().user;
      if (!currentUser) return;

      const client = createApiClient(origin, () => entry.token);
      const restoredInstance: ConnectedInstance = {
        origin,
        label: entry.label || new URL(origin).host,
        token: entry.token,
        user: currentUser,
        username: entry.username || '',
        status: 'connecting' as const,
        api: client,
      };

      set((state) => ({
        instances: [...state.instances, restoredInstance],
      }));

      inst = restoredInstance;
    }

    if (inst.status === 'connected' || inst.status === 'connecting') return;

    // Tokenless placeholders can't reconnect — they need full re-authentication
    if (!inst.token) return;

    // Set to connecting
    set((state) => ({
      instances: state.instances.map(i =>
        i.origin === origin ? { ...i, status: 'connecting' as const, error: undefined } : i
      ),
    }));

    try {
      const user = await inst.api.users.me();

      // Refresh the instance label (non-critical — a failure here must not
      // block a successful token reconnect).
      let info: (InstanceInfoResponse) | null = null;
      try {
        info = await inst.api.instance.info();
      } catch {
        // Keep whatever label the instance already had.
      }

      set((state) => ({
        instances: state.instances.map(i =>
          i.origin === origin
            ? {
                ...i,
                status: 'connected' as const,
                user,
                error: undefined,
                ...(info
                  ? {
                      label: info.name,
                    }
                  : {}),
              }
            : i
        ),
      }));

      // Update registry entry on successful reconnect
      const registry = upsertRegistryEntry(get().registry, origin, {
        origin,
        status: 'connected',
        lastConnectedAt: Date.now(),
        disconnectedAt: null,
        errorMessage: null,
      });
      const registryUpdatedAt = Date.now();
      set({ registry, registryUpdatedAt });
      get().syncRegistry().catch(() => {});

      connectInstance(origin, inst.token);
    } catch (err) {
      if (isNetworkError(err)) {
        set((state) => ({
          instances: state.instances.map(i =>
            i.origin === origin
              ? { ...i, status: 'disconnected' as const, error: 'Instance unreachable — retrying in background' }
              : i
          ),
        }));

        // Update registry on network error
        const errRegistry = upsertRegistryEntry(get().registry, origin, {
          origin,
          status: 'unreachable',
          errorMessage: 'Instance unreachable',
        });
        set({ registry: errRegistry, registryUpdatedAt: Date.now() });

        connectInstance(origin, inst.token);
      } else {
        set((state) => ({
          instances: state.instances.map(i =>
            i.origin === origin
              ? { ...i, status: 'error' as const, error: 'Token expired — re-authenticate to reconnect' }
              : i
          ),
        }));

        // Update registry on auth error
        const errRegistry = upsertRegistryEntry(get().registry, origin, {
          origin,
          status: 'auth_expired',
          errorMessage: 'Token expired',
        });
        set({ registry: errRegistry, registryUpdatedAt: Date.now() });
      }
    }
  },

  reauthenticateInstance: async (origin: string, password: string) => {
    const inst = get().instances.find(i => i.origin === origin);

    // Clean up existing instance if present (stale placeholder or disconnected entry)
    if (inst) {
      set((state) => ({
        instances: state.instances.filter(i => i.origin !== origin),
      }));
      useSpaceStore.getState().removeInstanceSpaces(origin);
    }

    // Disconnect any lingering WS
    disconnectWs(origin);

    // Re-connect through the standard flow (handles register/login)
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;

    await get().connectToRemote(
      origin,
      password,
      currentUser.displayName || undefined,
    );

    // Clear pending password sync — connectToRemote uses the current password
    // which updates the remote's stored hash through register/login
    get().setPendingPasswordSync(origin, false);
  },

  updateInstanceToken: (origin: string, newToken: string) => {
    set((state) => ({
      instances: state.instances.map(i => {
        if (i.origin !== origin) return i;
        // Recreate API client with new token
        const newApi = createApiClient(origin, () => newToken);
        return { ...i, token: newToken, api: newApi };
      }),
    }));

    const userId = useAuthStore.getState().user?.id;
    if (userId) saveCachedTokens(get().instances, userId);

    // Reconnect WebSocket with new token
    disconnectWs(origin);
    connectInstance(origin, newToken);
  },

  setPendingPasswordSync: (origin: string, pending: boolean) => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;

    // Update Zustand state (triggers React re-renders)
    set((state) => ({
      pendingSyncOrigins: pending
        ? state.pendingSyncOrigins.includes(origin)
          ? state.pendingSyncOrigins
          : [...state.pendingSyncOrigins, origin]
        : state.pendingSyncOrigins.filter(o => o !== origin),
    }));

    // Also persist to localStorage
    const flags: Record<string, boolean> = { [origin]: pending };
    saveCachedTokens(get().instances, userId, flags);
  },

  hasPendingPasswordSync: (origin: string) => {
    return get().pendingSyncOrigins.includes(origin);
  },

  syncInstanceList: async () => {
    // Prevent premature sync before autoConnectAll has populated all server-known
    // instances — otherwise a user action (add/remove) would overwrite the server
    // record with only the currently-loaded subset, permanently erasing the rest
    if (!get()._autoConnectDone) return;

    const { instances } = get();
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;

    // Build perspective-correct replicated instance lists.
    // Each instance should store references to OTHER instances, never itself.
    const homeOrigin = window.location.origin;
    const homeUsername = currentUser.username.includes('@')
      ? currentUser.username.split('@')[0]!
      : currentUser.username;

    // Home list: all remotes (home never references itself)
    const homeList: ReplicatedInstance[] = instances.map(inst => ({
      origin: inst.origin,
      username: inst.username,
    }));

    // Push to home instance
    const homePromise = api.users.update({ replicatedInstances: homeList }).catch((err) => {
      console.warn('Failed to sync instance list to home:', err);
    });

    // Push perspective-correct list to each remote instance:
    // include home + all OTHER remotes, but exclude the remote's own origin
    const connectedInstances = instances.filter(inst => inst.status === 'connected');
    const remotePromises = connectedInstances.map(inst => {
      const listForRemote: ReplicatedInstance[] = [
        { origin: homeOrigin, username: homeUsername },
        ...instances
          .filter(other => other.origin !== inst.origin)
          .map(other => ({ origin: other.origin, username: other.username })),
      ];
      return inst.api.users.update({ replicatedInstances: listForRemote }).catch((err) => {
        console.warn(`Failed to sync instance list to ${inst.origin}:`, err);
      });
    });

    await Promise.all([homePromise, ...remotePromises]);
  },

  syncRegistry: async () => {
    if (!get()._autoConnectDone) return;
    // Block PUT until we've successfully read the authoritative server registry
    // at least once. Otherwise a transient GET failure during autoConnectAll
    // would let us push an empty/incomplete registry with a fresh timestamp,
    // wiping legitimate server-side entries via LWW.
    if (!get()._registrySyncReady) return;

    const { registry, registryUpdatedAt, instances } = get();
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;

    const entries = Array.from(registry.values());
    const payload = { registry: entries, updatedAt: registryUpdatedAt };

    // Push to home instance
    const homePromise = api.users.putFederationRegistry(payload).catch((err) => {
      console.warn('Failed to sync registry to home:', err);
    });

    // Push to all connected remote instances
    const connectedInstances = instances.filter(i => i.status === 'connected');
    const remotePromises = connectedInstances.map(inst =>
      inst.api.users.putFederationRegistry(payload).catch((err) => {
        console.warn(`Failed to sync registry to ${inst.origin}:`, err);
      })
    );

    await Promise.all([homePromise, ...remotePromises]);
  },

  deleteIdentity: async (origins: string[], mode: 'leave' | 'soft' | 'full' = 'leave') => {
    try {
      const { results } = await api.users.deleteFederationIdentity({ origins, mode });

      // Clean up client-side state for successful deletions
      for (const [origin, result] of Object.entries(results)) {
        if (result.success) {
          get().forceRemoveEntry(origin);
        }
      }

      return results;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return Object.fromEntries(origins.map(o => [o, { success: false as const, error }]));
    }
  },

  forceRemoveEntry: (origin: string) => {
    // Tear down WebSocket if connected
    disconnectWs(origin);

    // Remove from registry
    const registry = new Map(get().registry);
    registry.delete(origin);
    const registryUpdatedAt = Date.now();

    // Remove from instances and purge token from localStorage
    set((state) => {
      const updated = state.instances.filter(i => i.origin !== origin);
      const userId = useAuthStore.getState().user?.id;
      if (userId) saveCachedTokens(updated, userId);
      return { instances: updated, registry, registryUpdatedAt };
    });

    // Same rationale as disconnectInstance — preserve DMs with connected alts.
    failoverDmOriginsFromDisconnected(origin);
    useSpaceStore.getState().removeInstanceSpaces(origin);

    get().syncRegistry().catch(() => {});
  },

  autoConnectAll: async () => {
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) {
      set({ _autoConnectDone: true });
      return;
    }

    const cached = loadCachedTokens(currentUser.id);

    // Fetch server-side registry (source of truth for entry list)
    let serverRegistry: FederationRegistryEntry[] = [];
    let serverRegistryUpdatedAt = 0;
    let serverRegistryFetched = false;
    try {
      const res = await api.users.getFederationRegistry();
      serverRegistry = res.registry;
      serverRegistryUpdatedAt = res.updatedAt;
      serverRegistryFetched = true;
    } catch (err) {
      console.warn('Failed to fetch federation registry from home:', err);
    }

    // Initialize registry from server data
    const registry = new Map<string, FederationRegistryEntry>();
    for (const entry of serverRegistry) {
      registry.set(entry.origin, entry);
    }

    // Seed any replicatedInstances that aren't yet in the registry. This covers
    // (a) accounts whose remotes were added before the federation registry table
    // existed, and (b) the GET-failed degraded mode where we still want the user
    // to see their known connections (as auth_expired) instead of an empty list.
    // These synthesized entries are display-only until the next successful GET
    // — we never PUT while _registrySyncReady is false.
    for (const ri of currentUser.replicatedInstances) {
      const origin = ri.origin || `https://${ri.domain}`;
      if (isSelfOrigin(origin)) continue;
      if (registry.has(origin)) continue;
      registry.set(origin, {
        origin,
        label: new URL(origin).host,
        username: ri.username || '',
        remoteUserId: '',
        status: 'auth_expired',
        addedAt: Date.now(),
        lastConnectedAt: null,
        disconnectedAt: null,
        errorMessage: 'Re-authenticate to connect',
      });
    }

    // Migration: promote localStorage-only entries to registry
    for (const [origin] of Object.entries(cached)) {
      if (origin === window.location.origin) continue;
      if (!registry.has(origin)) {
        registry.set(origin, {
          origin,
          label: cached[origin]?.label || new URL(origin).host,
          username: cached[origin]?.username || '',
          remoteUserId: '',
          status: 'connected',
          addedAt: Date.now(),
          lastConnectedAt: Date.now(),
          disconnectedAt: null,
          errorMessage: null,
        });
      }
    }

    // If logged in as a federated user, include the home instance as a
    // connection target. It won't be in replicatedInstances (you don't
    // "federate to" your own home), but the client needs it for friends,
    // DMs, and profile data.
    const instancesToConnect = [...currentUser.replicatedInstances];
    if (currentUser.homeInstance) {
      const homeOrigin = `https://${currentUser.homeInstance}`;
      if (!isSelfOrigin(homeOrigin)) {
        // Compute bare username (strip @domain suffix if present)
        const bareUsername = currentUser.username.includes('@')
          ? currentUser.username.split('@')[0]!
          : currentUser.username;

        const alreadyIncluded = instancesToConnect.some(ri =>
          (ri.origin || `https://${ri.domain}`) === homeOrigin
        );
        if (!alreadyIncluded) {
          instancesToConnect.push({
            origin: homeOrigin,
            username: bareUsername,
            domain: currentUser.homeInstance,
          });
        }

        // Ensure the home instance has a registry entry so it appears
        // in the Connections UI (the registry is the source of truth for
        // the Connections panel, not the instances array).
        if (!registry.has(homeOrigin)) {
          registry.set(homeOrigin, {
            origin: homeOrigin,
            label: currentUser.homeInstance,
            username: bareUsername,
            remoteUserId: currentUser.homeUserId ?? '',
            status: 'auth_expired',
            addedAt: Date.now(),
            lastConnectedAt: null,
            disconnectedAt: null,
            errorMessage: 'Authenticate to connect to your home instance',
          });
        }
      }
    }

    // Early return if there's nothing to connect
    if (instancesToConnect.length === 0 && registry.size === 0) {
      set({ _autoConnectDone: true });
      return;
    }

    // Split server-known instances into three groups:
    // - withToken: have a cached token and should auto-connect
    // - withoutToken: no cached token → add as error placeholder
    // - userDisconnected: user explicitly disconnected → add as disconnected placeholder (no auto-connect)
    const withToken: Array<{ origin: string; ri: (typeof instancesToConnect)[0]; entry: CachedInstanceToken }> = [];
    const withoutToken: Array<{ origin: string; ri: (typeof instancesToConnect)[0] }> = [];
    const userDisconnected: Array<{ origin: string; ri: (typeof instancesToConnect)[0]; entry: CachedInstanceToken }> = [];

    for (const ri of instancesToConnect) {
      const origin = ri.origin || `https://${ri.domain}`;
      // Never connect to ourselves — home WS is managed separately
      if (isSelfOrigin(origin)) continue;
      if (get().instances.some(i => i.origin === origin)) continue; // already loaded
      const cachedEntry = cached[origin];
      const regEntry = registry.get(origin);
      if (cachedEntry) {
        // Respect user's explicit disconnect — don't auto-reconnect
        if (regEntry?.status === 'disconnected') {
          userDisconnected.push({ origin, ri, entry: cachedEntry });
        } else {
          withToken.push({ origin, ri, entry: cachedEntry });
        }
      } else {
        withoutToken.push({ origin, ri });
      }
    }

    // Add user-disconnected instances as disconnected placeholders (token preserved
    // so reconnect is instant, but no WebSocket or API calls until user clicks reconnect)
    if (userDisconnected.length > 0) {
      set((state) => {
        const placeholders: ConnectedInstance[] = userDisconnected.map(({ origin, entry: cachedEntry }) => ({
          origin,
          label: cachedEntry.label || new URL(origin).host,
          token: cachedEntry.token,
          user: currentUser,
          username: cachedEntry.username || '',
          status: 'disconnected' as const,
          api: createApiClient(origin, () => cachedEntry.token),
        }));
        return { instances: [...state.instances, ...placeholders] };
      });
    }

    // Immediately add tokenless placeholders so they're visible in Zustand
    // (and therefore won't be erased by syncInstanceList)
    if (withoutToken.length > 0) {
      set((state) => {
        const placeholders: ConnectedInstance[] = withoutToken.map(({ origin, ri }) => ({
          origin,
          label: new URL(origin).host,
          token: '',
          user: currentUser, // placeholder
          username: ri.username,
          status: 'error' as const,
          error: 'Session expired — re-authenticate to reconnect',
          api: createApiClient(origin, () => null),
        }));
        return { instances: [...state.instances, ...placeholders] };
      });
    }

    // Update registry for tokenless placeholders
    for (const { origin } of withoutToken) {
      const entry = registry.get(origin);
      if (entry) {
        registry.set(origin, { ...entry, status: 'auth_expired', errorMessage: 'Session expired — re-authenticate to reconnect' });
      }
    }

    // Connect instances with cached tokens in parallel
    if (withToken.length > 0) {
      const results = await Promise.allSettled(
        withToken.map(async ({ origin, ri, entry: cachedEntry }) => {
          // Create client with cached token
          const client = createApiClient(origin, () => cachedEntry.token);

          // Set as connecting
          const connectingInstance: ConnectedInstance = {
            origin,
            label: cachedEntry.label || new URL(origin).host,
            token: cachedEntry.token,
            user: currentUser, // Placeholder until we verify
            username: cachedEntry.username || ri.username,
            status: 'connecting',
            api: client,
          };

          set((state) => ({
            instances: [...state.instances.filter(i => i.origin !== origin), connectingInstance],
          }));

          try {
            // Verify the token is still valid
            const user = await client.users.me();

            // Fetch instance info for a fresh label
            let label = cachedEntry.label || new URL(origin).host;
            let info: InstanceInfoResponse | null = null;
            try {
              info = await client.instance.info();
              label = info.name;
            } catch {
              // Non-critical — keep cached label
            }

            // Backfill homeUserId if missing (existing federated users before this field existed)
            if (user.homeInstance && !user.homeUserId) {
              const homeUser = useAuthStore.getState().user;
              if (homeUser) {
                client.users.update({ homeUserId: homeUser.id }).catch(() => {});
              }
            }

            // Backfill cached username if stale after server-side migration
            // (e.g. "test" was renamed to "test@nova.ddns.net")
            if (user.username !== cachedEntry.username) {
              cachedEntry.username = user.username;
            }

            const connectedInstance: ConnectedInstance = {
              origin,
              label,
              token: cachedEntry.token,
              user,
              username: user.username,
              status: 'connected',
              api: client,
            };

            set((state) => ({
              instances: state.instances.map(i => i.origin === origin ? connectedInstance : i),
            }));

            // Update registry entry on successful reconnect
            const entry = registry.get(origin);
            if (entry) {
              registry.set(origin, { ...entry, status: 'connected', lastConnectedAt: Date.now(), disconnectedAt: null, errorMessage: null, remoteUserId: user.id, label });
            }

            // Open WebSocket connection now that we've verified the token
            connectInstance(origin, cachedEntry.token);

            // Initiate server-to-server peering for DM relay (non-fatal, idempotent)
            api.federation.ensurePeered({ remoteOrigin: origin }).catch(() => {});
          } catch (err) {
            if (isNetworkError(err)) {
              // Instance unreachable (NAT hairpinning, DNS, server down) — token may still be valid
              set((state) => ({
                instances: state.instances.map(i =>
                  i.origin === origin
                    ? { ...i, status: 'disconnected' as const, error: 'Instance unreachable — retrying in background' }
                    : i
                ),
              }));

              // Update registry entry on network error
              const entry = registry.get(origin);
              if (entry) {
                registry.set(origin, { ...entry, status: 'unreachable', errorMessage: 'Instance unreachable' });
              }

              // Start WebSocket — its built-in exponential backoff retry will auto-recover
              // when the network path becomes available (e.g. user switches networks)
              connectInstance(origin, cachedEntry.token);
            } else {
              // Auth failure (401, invalid token, etc.)
              set((state) => ({
                instances: state.instances.map(i =>
                  i.origin === origin
                    ? { ...i, status: 'error' as const, error: 'Token expired — re-authenticate to reconnect' }
                    : i
                ),
              }));

              // Update registry entry on auth error
              const entry = registry.get(origin);
              if (entry) {
                registry.set(origin, { ...entry, status: 'auth_expired', errorMessage: 'Token expired' });
              }
            }
          }
        })
      );

      // Log any failures for debugging
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        console.warn(`autoConnectAll: ${failures.length}/${withToken.length} instances failed to connect`);
      }
    }

    // Save final state to localStorage — persist ALL instances regardless of status
    // so tokens are preserved for instant reconnect (registry controls auto-connect behavior)
    saveCachedTokens(get().instances, currentUser.id);

    // Hydrate pendingSyncOrigins from localStorage cache and mark auto-connect done
    const freshCached = loadCachedTokens(currentUser.id);
    const pendingOrigins = Object.entries(freshCached)
      .filter(([, v]) => v.pendingPasswordSync)
      .map(([origin]) => origin);

    // Persist reconciled registry. _registrySyncReady gates outbound PUTs:
    // only flip true when we've authoritatively read from the home server.
    const registryUpdatedAt = serverRegistryUpdatedAt > 0 ? Math.max(serverRegistryUpdatedAt, Date.now()) : Date.now();
    set({
      _autoConnectDone: true,
      pendingSyncOrigins: pendingOrigins,
      registry,
      registryUpdatedAt,
      _registrySyncReady: serverRegistryFetched,
    });

    // Sync reconciled registry to all instances (no-ops if fetch failed)
    if (serverRegistryFetched) {
      get().syncRegistry().catch(() => {});
    }
  },

  reset: () => {
    // Clean up space store for each connected remote instance before tearing down
    const { instances } = get();
    for (const inst of instances) {
      useSpaceStore.getState().removeInstanceSpaces(inst.origin);
    }

    // Tear down all remote WebSocket connections
    disconnectAllRemote();

    clearPasswordSyncTimers();

    set({ instances: [], isLoading: false, error: null, _autoConnectDone: false, pendingSyncOrigins: [], registry: new Map(), registryUpdatedAt: 0, _registrySyncReady: false });
    // Token cache preserved — scoped per user, survives logout for seamless reconnect
  },
}));

// ─── API client resolution ───────────────────────────────────────────────────
// Register the resolver with spaceStore so getApiForOrigin() works everywhere.
// Placed after store creation so useInstanceStore is definitely initialized.
// This breaks the circular dependency: chatStore → spaceStore ← instanceStore
// instead of: chatStore → instanceStore → useWebSocket → chatStore (cycle).

setApiForOriginResolver((origin: string): BackspaceApiClient => {
  if (!origin) return api;
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  if (!instance) return api;
  return instance.api;
});

// ─── User ID resolution (federation) ──────────────────────────────────────────
// Maps an origin to the local user's ID on that remote instance.
// Used by voice join/leave to optimistically add/remove the correct user ID.

setUserIdForOriginResolver((origin: string): string | undefined => {
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  return instance?.user.id;
});

// ─── Token resolution (federation) ────────────────────────────────────────────
// Maps an origin to the JWT for that instance. Used by transferStore for tus
// uploads and any other path that constructs raw HTTP requests to a federated
// instance and needs to pass an Authorization header.
//
// Empty origin reads from localStorage, mirroring the home `api` client
// (api/client.ts). authStore.token is the React-state mirror of the same value
// and is written together with localStorage by initSession/logout — but the
// register page intentionally writes localStorage *before* initSession (so
// AuthRedirect doesn't yank the user off /register while the avatar is still
// uploading). Reading authStore.token here would return null in that window
// and the upload would silently fail. Aligning with the api client closes the
// gap and gives one source of truth for the home JWT.

setTokenForOriginResolver((origin: string): string | null => {
  if (!origin) return localStorage.getItem('backspace_token');
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  return instance?.token ?? null;
});

// ─── Electron: push connected-instance origins to main process ───────────────
// Enables the main process to intercept invite URLs that point to instances
// we're already signed into. Uses the basic subscribe(listener) form (no
// subscribeWithSelector middleware on this store) with a manual diff to avoid
// IPC spam on unrelated state changes (e.g. isLoading toggles, registry updates).
{
  let lastSerialized = '';
  const pushOrigins = (instances: ConnectedInstance[]) => {
    if (typeof window === 'undefined' || !window.backspace?.setConnectedOrigins) return;
    const origins = [
      window.location.origin,
      ...instances
        .filter(i => i.status === 'connected')
        .map(i => i.origin)
        .filter(Boolean),
    ];
    const serialized = origins.join('|');
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    window.backspace.setConnectedOrigins(origins);
  };

  // Initial push (current state at module load time)
  pushOrigins(useInstanceStore.getState().instances);

  // Push on every state change; guard above skips when origin set is unchanged
  useInstanceStore.subscribe((state) => {
    pushOrigins(state.instances);
  });
}

// ─── Hostname → origin resolution (federation) ────────────────────────────────
// Maps a user's homeInstance hostname to its full origin URL.

setOriginFromHostnameResolver((hostname: string): string => {
  const inst = useInstanceStore.getState().instances.find(i => {
    try { return new URL(i.origin).host === hostname; } catch { return false; }
  });
  return inst?.origin ?? '';
});
