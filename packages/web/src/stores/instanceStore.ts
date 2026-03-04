import { create } from 'zustand';
import type { User, InstanceInfoResponse, ReplicatedInstance, AuthResponse } from '@backspace/shared';
import { BackspaceApiClient, createApiClient, api } from '../api/client';
import { useAuthStore } from './authStore';
import { setApiForOriginResolver, useServerStore } from './serverStore';
import { connectInstance, disconnectInstance, disconnectAllRemote } from '../hooks/useWebSocket';

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
}

const STORAGE_KEY = 'backspace_instances';

// ─── localStorage helpers ────────────────────────────────────────────────────

function loadCachedTokens(): Record<string, CachedInstanceToken> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, CachedInstanceToken>;
  } catch {
    return {};
  }
}

function saveCachedTokens(instances: ConnectedInstance[]): void {
  const cache: Record<string, CachedInstanceToken> = {};
  for (const inst of instances) {
    cache[inst.origin] = {
      token: inst.token,
      label: inst.label,
      username: inst.username,
    };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
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

// ─── Store ───────────────────────────────────────────────────────────────────

interface InstanceState {
  instances: ConnectedInstance[];
  isLoading: boolean;
  error: string | null;

  probeInstance: (url: string) => Promise<InstanceInfoResponse & { origin: string }>;
  connectToRemote: (origin: string, password: string, displayName?: string) => Promise<void>;
  loginToRemote: (origin: string, username: string, password: string) => Promise<void>;
  removeInstance: (origin: string) => void;
  setInstanceStatus: (origin: string, status: ConnectedInstance['status'], error?: string) => void;
  reconnectInstance: (origin: string) => Promise<void>;
  syncInstanceList: () => Promise<void>;
  autoConnectAll: () => Promise<void>;
  reset: () => void;
}

export const useInstanceStore = create<InstanceState>((set, get) => ({
  instances: [],
  isLoading: false,
  error: null,

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
      // Step 1: Verify password against HOME instance
      const { valid } = await api.users.verifyPassword(password);
      if (!valid) {
        throw new Error('Incorrect password');
      }

      // Step 2: Try register on remote, then fall back to login
      const homeInstance = window.location.host;
      const tempClient = createApiClient(origin, () => null);

      let response: AuthResponse | null = null;
      const finalUsername = `${currentUser.username}@${homeInstance}`;

      // 2a: Attempt registration with namespaced username
      try {
        response = await tempClient.auth.register({
          username: finalUsername,
          password,
          displayName: displayName || currentUser.displayName || undefined,
          homeInstance,
          homeUserId: currentUser.id,
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
              username: currentUser.username,
              password,
            });
          } catch {
            throw new DifferentPasswordError(currentUser.username);
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
        saveCachedTokens(updated);
        return { instances: updated, isLoading: false };
      });

      // Open WebSocket connection to the remote instance
      connectInstance(origin, response.token);

      // Sync instance list to all instances (fire-and-forget)
      get().syncInstanceList().catch(() => {});
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
        saveCachedTokens(updated);
        return { instances: updated, isLoading: false };
      });

      // Open WebSocket connection to the remote instance
      connectInstance(origin, response.token);

      // Sync instance list to all instances (fire-and-forget)
      get().syncInstanceList().catch(() => {});
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

  removeInstance: (origin: string) => {
    // Tear down WebSocket connection
    disconnectInstance(origin);

    set((state) => {
      const updated = state.instances.filter(i => i.origin !== origin);
      saveCachedTokens(updated);
      return { instances: updated };
    });

    // Remove servers from this instance from the server store
    useServerStore.getState().removeInstanceServers(origin);

    // Sync updated list to remaining instances (fire-and-forget)
    get().syncInstanceList().catch(() => {});
  },

  reconnectInstance: async (origin: string) => {
    const inst = get().instances.find(i => i.origin === origin);
    if (!inst || inst.status === 'connected' || inst.status === 'connecting') return;

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

  syncInstanceList: async () => {
    const { instances } = get();
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;

    // Build the replicated instances list from all connected remotes
    const replicatedInstances: ReplicatedInstance[] = instances.map(inst => ({
      origin: inst.origin,
      username: inst.username,
    }));

    // Push to home instance
    const homePromise = api.users.update({ replicatedInstances }).catch((err) => {
      console.warn('Failed to sync instance list to home:', err);
    });

    // Push to each remote instance
    const remotePromises = instances
      .filter(inst => inst.status === 'connected')
      .map(inst =>
        inst.api.users.update({ replicatedInstances }).catch((err) => {
          console.warn(`Failed to sync instance list to ${inst.origin}:`, err);
        })
      );

    await Promise.all([homePromise, ...remotePromises]);
  },

  autoConnectAll: async () => {
    const currentUser = useAuthStore.getState().user;
    if (!currentUser || currentUser.replicatedInstances.length === 0) return;

    const cached = loadCachedTokens();
    const toConnect = currentUser.replicatedInstances.filter(ri => {
      const origin = ri.origin || `https://${ri.domain}`;
      // Only attempt if we have a cached token and aren't already connected
      return cached[origin] && !get().instances.some(i => i.origin === origin);
    });

    if (toConnect.length === 0) return;

    // Connect all in parallel, individual failures are non-blocking
    const results = await Promise.allSettled(
      toConnect.map(async (ri) => {
        const origin = ri.origin || `https://${ri.domain}`;
        const cachedEntry = cached[origin]!; // Guaranteed by filter above

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

          // Open WebSocket connection now that we've verified the token
          connectInstance(origin, cachedEntry.token);
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
          }
        }
      })
    );

    // Save final state to localStorage — persist ALL instances regardless of status
    // so disconnected instances survive page reload and can auto-reconnect later
    saveCachedTokens(get().instances);

    // Log any failures for debugging
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.warn(`autoConnectAll: ${failures.length}/${toConnect.length} instances failed to connect`);
    }
  },

  reset: () => {
    // Clean up server store for each connected remote instance before tearing down
    const { instances } = get();
    for (const inst of instances) {
      useServerStore.getState().removeInstanceServers(inst.origin);
    }

    // Tear down all remote WebSocket connections
    disconnectAllRemote();

    set({ instances: [], isLoading: false, error: null });
    localStorage.removeItem(STORAGE_KEY);
  },
}));

// ─── API client resolution ───────────────────────────────────────────────────
// Register the resolver with serverStore so getApiForOrigin() works everywhere.
// Placed after store creation so useInstanceStore is definitely initialized.
// This breaks the circular dependency: chatStore → serverStore ← instanceStore
// instead of: chatStore → instanceStore → useWebSocket → chatStore (cycle).

setApiForOriginResolver((origin: string): BackspaceApiClient => {
  if (!origin) return api;
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  if (!instance) return api;
  return instance.api;
});
