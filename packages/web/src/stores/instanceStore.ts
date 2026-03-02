import { create } from 'zustand';
import type { User, InstanceInfoResponse, ReplicatedInstance } from '@backspace/shared';
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
  registerOnRemote: (origin: string, password: string, displayName?: string) => Promise<void>;
  loginToRemote: (origin: string, username: string, password: string) => Promise<void>;
  removeInstance: (origin: string) => void;
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

  registerOnRemote: async (origin: string, password: string, displayName?: string) => {
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) throw new Error('Not logged in');

    set({ isLoading: true, error: null });

    try {
      const homeInstance = window.location.host;
      const tempClient = createApiClient(origin, () => null);

      let response;
      let finalUsername = currentUser.username;

      try {
        // First attempt: register with current username
        response = await tempClient.auth.register({
          username: currentUser.username,
          password,
          displayName: displayName || currentUser.displayName || undefined,
          homeInstance,
        });
      } catch (err) {
        const message = (err as Error).message;
        // If username taken, retry with domain-qualified username
        if (message.includes('already taken') || message.includes('409')) {
          finalUsername = `${currentUser.username}@${homeInstance}`;
          response = await tempClient.auth.register({
            username: finalUsername,
            password,
            displayName: displayName || currentUser.displayName || undefined,
            homeInstance,
          });
        } else {
          throw err;
        }
      }

      // Fetch instance info for the label
      const info = await tempClient.instance.info();

      // Create authenticated client
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

  syncInstanceList: async () => {
    const { instances } = get();
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;

    // Build the replicated instances list from all connected remotes
    const replicatedInstances: ReplicatedInstance[] = instances.map(inst => ({
      domain: new URL(inst.origin).host,
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
      // Build origin from domain
      const origin = `https://${ri.domain}`;
      // Only attempt if we have a cached token and aren't already connected
      return cached[origin] && !get().instances.some(i => i.origin === origin);
    });

    if (toConnect.length === 0) return;

    // Connect all in parallel, individual failures are non-blocking
    const results = await Promise.allSettled(
      toConnect.map(async (ri) => {
        const origin = `https://${ri.domain}`;
        const cachedEntry = cached[origin]!; // Guaranteed by filter above

        // Create client with cached token
        const client = createApiClient(origin, () => cachedEntry.token);

        // Set as connecting
        const connectingInstance: ConnectedInstance = {
          origin,
          label: cachedEntry.label || ri.domain,
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
          let label = cachedEntry.label || ri.domain;
          try {
            const info = await client.instance.info();
            label = info.name;
          } catch {
            // Non-critical — keep cached label
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
        } catch {
          // Token expired or instance unreachable
          set((state) => ({
            instances: state.instances.map(i =>
              i.origin === origin
                ? { ...i, status: 'disconnected' as const, error: 'Token expired — re-authenticate to reconnect' }
                : i
            ),
          }));
        }
      })
    );

    // Save final state to localStorage
    saveCachedTokens(get().instances.filter(i => i.status === 'connected'));

    // Log any failures for debugging
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.warn(`autoConnectAll: ${failures.length}/${toConnect.length} instances failed to connect`);
    }
  },

  reset: () => {
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
