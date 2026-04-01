import { create } from 'zustand';
import type { User, InstanceInfoResponse, ReplicatedInstance, AuthResponse, FederationRegistryEntry } from '@backspace/shared';
import { BackspaceApiClient, createApiClient, api } from '../api/client';
import { useAuthStore } from './authStore';
import { setApiForOriginResolver, setUserIdForOriginResolver, setOriginFromHostnameResolver, useSpaceStore } from './spaceStore';
import { connectInstance, disconnectInstance as disconnectWs, disconnectAllRemote } from '../hooks/useWebSocket';
import { syncProfileToRemote } from '../utils/profileSync';
// Circular dependency: federationOps imports useInstanceStore, instanceStore imports this.
// Safe because both modules access each other lazily (at call time, not import time).
// clearPasswordSyncTimers itself does not reference useInstanceStore.
import { clearPasswordSyncTimers } from '../utils/federationOps';
import { useUIStore } from './uiStore';

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
  syncRegistry: () => Promise<void>;
  deleteIdentity: (origin: string) => void;
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

  probeInstance: async (url: string) => {
    const origin = normalizeOrigin(url);

    // Reject self-connection
    if (origin === window.location.origin) {
      throw new Error('Cannot add your home instance as a remote instance');
    }

    // Reject duplicates
    if (get().instances.some(i => i.origin === origin)) {
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
      // If we're a federated user (e.g. youruser@nova browsing orbit),
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

      // Sync home profile to new remote (fire-and-forget).
      // Skip when target is home — home is the source of truth for profile data.
      if (!targetIsHome) {
        syncProfileToRemote(instance).catch((err) => {
          console.warn(`[ProfileSync] Initial sync to ${origin} failed:`, err);
        });
      }

      // Initiate server-to-server peering for DM relay (non-fatal)
      try {
        await api.federation.initiatePeering({ remoteOrigin: origin });
      } catch (err) {
        console.warn('[federation] Peering initiation failed (non-fatal):', err);
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

      // Sync full home profile to remote (fire-and-forget)
      syncProfileToRemote(instance).catch((err) => {
        console.warn(`[ProfileSync] Login sync to ${origin} failed:`, err);
      });

      // Sync instance list to all instances (fire-and-forget)
      get().syncInstanceList().catch(() => {});
      get().syncRegistry().catch(() => {});
    } catch (err) {
      set({ isLoading: false, error: (err as Error).message });
      throw err;
    }
  },

  setInstanceStatus: (origin, status, error) => {
    set((state) => ({
      instances: state.instances.map(i =>
        i.origin === origin ? { ...i, status, error } : i
      ),
    }));
  },

  disconnectInstance: (origin: string) => {
    // Tear down WebSocket connection
    disconnectWs(origin);

    // Update registry entry to disconnected (preserve the entry)
    const registry = upsertRegistryEntry(get().registry, origin, {
      origin,
      status: 'disconnected',
      disconnectedAt: Date.now(),
      errorMessage: null,
    });
    const registryUpdatedAt = Date.now();

    set((state) => {
      const updated = state.instances.filter(i => i.origin !== origin);
      const userId = useAuthStore.getState().user?.id;
      if (userId) saveCachedTokens(updated, userId);
      return { instances: updated, registry, registryUpdatedAt };
    });

    // Remove spaces from this instance from the space store
    useSpaceStore.getState().removeInstanceSpaces(origin);

    // Sync updated lists to remaining instances (fire-and-forget)
    get().syncInstanceList().catch(() => {});
    get().syncRegistry().catch(() => {});
  },

  reconnectInstance: async (origin: string) => {
    const inst = get().instances.find(i => i.origin === origin);
    if (!inst || inst.status === 'connected' || inst.status === 'connecting') return;

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

      set((state) => ({
        instances: state.instances.map(i =>
          i.origin === origin ? { ...i, status: 'connected' as const, user, error: undefined } : i
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
        connectInstance(origin, inst.token);
      } else {
        set((state) => ({
          instances: state.instances.map(i =>
            i.origin === origin
              ? { ...i, status: 'error' as const, error: 'Token expired — re-authenticate to reconnect' }
              : i
          ),
        }));
      }
    }
  },

  reauthenticateInstance: async (origin: string, password: string) => {
    const inst = get().instances.find(i => i.origin === origin);
    if (!inst) return;

    // Remove the stale placeholder
    set((state) => ({
      instances: state.instances.filter(i => i.origin !== origin),
    }));

    // Remove its spaces from the space store
    useSpaceStore.getState().removeInstanceSpaces(origin);

    // Disconnect any lingering WS
    disconnectWs(origin);

    // Re-connect through the standard flow (handles register/login)
    const currentUser = useAuthStore.getState().user;
    await get().connectToRemote(
      origin,
      password,
      currentUser?.displayName || undefined,
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

  deleteIdentity: (_origin: string) => {
    useUIStore.getState().addToast('Identity deletion is not yet implemented', 'info', 3000);
  },

  forceRemoveEntry: (origin: string) => {
    const registry = new Map(get().registry);
    registry.delete(origin);
    const registryUpdatedAt = Date.now();
    set({ registry, registryUpdatedAt });
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
    try {
      const res = await api.users.getFederationRegistry();
      serverRegistry = res.registry;
      serverRegistryUpdatedAt = res.updatedAt;
    } catch (err) {
      console.warn('Failed to fetch federation registry from home:', err);
    }

    // Initialize registry from server data
    const registry = new Map<string, FederationRegistryEntry>();
    for (const entry of serverRegistry) {
      registry.set(entry.origin, entry);
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

    // Early return if there's nothing to connect
    if (currentUser.replicatedInstances.length === 0 && registry.size === 0) {
      set({ _autoConnectDone: true });
      return;
    }

    // Split server-known instances into two groups:
    // - withToken: have a cached token → attempt reconnection
    // - withoutToken: no cached token → add as error placeholder
    const withToken: Array<{ origin: string; ri: (typeof currentUser.replicatedInstances)[0]; entry: CachedInstanceToken }> = [];
    const withoutToken: Array<{ origin: string; ri: (typeof currentUser.replicatedInstances)[0] }> = [];

    for (const ri of currentUser.replicatedInstances) {
      const origin = ri.origin || `https://${ri.domain}`;
      // Never connect to ourselves — home WS is managed separately
      if (origin === window.location.origin) continue;
      if (get().instances.some(i => i.origin === origin)) continue; // already loaded
      const entry = cached[origin];
      if (entry) {
        withToken.push({ origin, ri, entry });
      } else {
        withoutToken.push({ origin, ri });
      }
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

            // Fetch instance info for fresh label
            let label = cachedEntry.label || new URL(origin).host;
            try {
              const info = await client.instance.info();
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

            // Sync home profile to reconnected remote (fire-and-forget)
            syncProfileToRemote(connectedInstance).catch((err) => {
              console.warn(`[ProfileSync] Reconnect sync to ${origin} failed:`, err);
            });

            // Initiate server-to-server peering for DM relay (non-fatal, idempotent)
            api.federation.initiatePeering({ remoteOrigin: origin }).catch(() => {});
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
    // so disconnected instances survive page reload and can auto-reconnect later
    saveCachedTokens(get().instances, currentUser.id);

    // Hydrate pendingSyncOrigins from localStorage cache and mark auto-connect done
    const freshCached = loadCachedTokens(currentUser.id);
    const pendingOrigins = Object.entries(freshCached)
      .filter(([, v]) => v.pendingPasswordSync)
      .map(([origin]) => origin);

    // Persist reconciled registry
    const registryUpdatedAt = serverRegistryUpdatedAt > 0 ? Math.max(serverRegistryUpdatedAt, Date.now()) : Date.now();
    set({ _autoConnectDone: true, pendingSyncOrigins: pendingOrigins, registry, registryUpdatedAt });

    // Sync reconciled registry to all instances
    get().syncRegistry().catch(() => {});
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

    set({ instances: [], isLoading: false, error: null, _autoConnectDone: false, pendingSyncOrigins: [], registry: new Map(), registryUpdatedAt: 0 });
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

// ─── Hostname → origin resolution (federation) ────────────────────────────────
// Maps a user's homeInstance hostname to its full origin URL.

setOriginFromHostnameResolver((hostname: string): string => {
  const inst = useInstanceStore.getState().instances.find(i => {
    try { return new URL(i.origin).host === hostname; } catch { return false; }
  });
  return inst?.origin ?? '';
});
