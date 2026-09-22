import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FederationRegistryEntry, FederationRegistryStatus, User } from '@backspace/shared';
import { HttpError } from '../api/client';

// ── Home-instance API (`api`) ───────────────────────────────────────────────
const verifyPassword = vi.fn(async () => ({ valid: true }));
const federationCredential = vi.fn(async (data: { origin: string; markProvisioned?: boolean }) => ({
  origin: data.origin,
  secret: 'fake-issued-secret',
  provisioned: true,
}));
const getFederationRegistry = vi.fn(async () => ({ registry: [] as FederationRegistryEntry[], updatedAt: 0 }));
const putFederationRegistry = vi.fn(async () => ({ ok: true, updatedAt: 1 }));
const ensurePeered = vi.fn(async () => ({ peeringStatus: 'active' }));

// ── Remote-instance API (what `createApiClient` hands back) ─────────────────
const remoteRegister = vi.fn();
const remoteLogin = vi.fn();
const remoteInfo = vi.fn(async () => ({ name: 'Orbit' }));
const remoteMe = vi.fn();

// Spread the real module: the store extends HttpError at load time, so a bare
// object mock breaks the import.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: {
    users: {
      verifyPassword: () => verifyPassword(),
      federationCredential: (data: { origin: string; markProvisioned?: boolean }) => federationCredential(data),
      update: vi.fn(async () => ({})),
      getFederationRegistry: () => getFederationRegistry(),
      putFederationRegistry: (data: unknown) => putFederationRegistry(data),
      me: vi.fn(),
    },
    federation: { ensurePeered: () => ensurePeered() },
  },
  createApiClient: (origin: string) => ({
    auth: {
      register: (data: unknown) => remoteRegister(origin, data),
      login: (data: unknown) => remoteLogin(origin, data),
    },
    instance: { info: () => remoteInfo() },
    users: { me: () => remoteMe(), update: vi.fn(async () => ({})), reattach: vi.fn(), changePassword: vi.fn() },
  }),
}));

const connectInstance = vi.fn();
vi.mock('../hooks/useWebSocket', () => ({
  connectInstance: (origin: string, token: string) => connectInstance(origin, token),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));
vi.mock('../utils/dmOriginFailover', () => ({ failoverDmOriginsFromDisconnected: vi.fn() }));
vi.mock('./spaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      removeInstanceSpaces: vi.fn(),
      reloadDmsForOrigin: vi.fn(async () => {}),
    }),
  },
}));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

const HOME_USER: Partial<User> = {
  id: 'user-1',
  username: 'erin',
  displayName: 'Erin',
  homeInstance: null,
  homeUserId: 'user-1',
  replicatedInstances: [],
};
const session: { user: Partial<User> } = { user: HOME_USER };

vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: session.user, token: 'tok' }),
    { getState: () => ({ user: session.user, token: 'tok' }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

import { useInstanceStore } from './instanceStore';
import type { ConnectedInstance } from './instanceStore';

const REMOTE = 'https://orbit.example';
const TOKEN_KEY = 'backspace_instances_user-1';

// ── The property under test ─────────────────────────────────────────────────

/**
 * The registry status each live status may sit beside.
 *
 * The two projections are written together, so after any action that changes a
 * connection's state they must name the same state in their own vocabularies.
 * `connecting` is the one live status the registry has no word for: an attempt
 * in flight leaves the row saying whatever it last recorded, so every registry
 * status is consistent with it and these tests do not rest on that case.
 */
const REGISTRY_FOR_LIVE: Record<ConnectedInstance['status'], FederationRegistryStatus[]> = {
  connected: ['connected'],
  connecting: ['connected', 'disconnected', 'unreachable', 'auth_expired'],
  disconnected: ['disconnected', 'unreachable'],
  error: ['auth_expired'],
};

/**
 * Both halves for `origin`, having asserted that they exist and agree. The
 * caller then asserts the pair the action was supposed to produce, so a call
 * site that writes one half and forgets the other fails here rather than
 * surfacing later as spaces in the wrong half of the Explore page.
 */
function agreedStatuses(origin: string): { live: ConnectedInstance['status']; registry: FederationRegistryStatus } {
  const state = useInstanceStore.getState();
  const live = state.instances.find((i) => i.origin === origin);
  const entry = state.registry.get(origin);
  expect(live, `no live instance for ${origin}`).toBeDefined();
  expect(entry, `no registry entry for ${origin}`).toBeDefined();
  expect(
    REGISTRY_FOR_LIVE[live!.status],
    `live status "${live!.status}" beside registry status "${entry!.status}"`,
  ).toContain(entry!.status);
  return { live: live!.status, registry: entry!.status };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function remoteUser(overrides: Partial<User> = {}): User {
  return {
    id: 'remote-1',
    username: 'erin@nova.example',
    homeInstance: null,
    homeUserId: null,
    ...overrides,
  } as User;
}

function liveInstance(status: ConnectedInstance['status'], overrides: Partial<ConnectedInstance> = {}): ConnectedInstance {
  return {
    origin: REMOTE,
    label: 'Orbit',
    token: 'cached-token',
    username: 'erin@nova.example',
    user: remoteUser(),
    status,
    api: {
      users: { me: () => remoteMe() },
      instance: { info: () => remoteInfo() },
    } as unknown as ConnectedInstance['api'],
    ...overrides,
  };
}

function registryEntry(status: FederationRegistryStatus, overrides: Partial<FederationRegistryEntry> = {}): FederationRegistryEntry {
  return {
    origin: REMOTE,
    label: 'Orbit',
    username: 'erin@nova.example',
    remoteUserId: 'remote-1',
    status,
    addedAt: 1_000,
    lastConnectedAt: 2_000,
    disconnectedAt: null,
    errorMessage: null,
    ...overrides,
  };
}

/** Put the store in a known pair, so a half that is not written stays visibly behind. */
function seed(
  live: ConnectedInstance['status'],
  registry: FederationRegistryStatus,
  overrides: { live?: Partial<ConnectedInstance>; registry?: Partial<FederationRegistryEntry> } = {},
): void {
  useInstanceStore.setState({
    instances: [liveInstance(live, overrides.live)],
    registry: new Map([[REMOTE, registryEntry(registry, overrides.registry)]]),
  });
}

/** A token in the per-user cache, which is what `autoConnectAll` connects from. */
function cacheToken(token: string): void {
  localStorage.setItem(
    TOKEN_KEY,
    JSON.stringify({ [REMOTE]: { token, label: 'Orbit', username: 'erin@nova.example' } }),
  );
}

const unreachable = () => new TypeError('Failed to fetch');
const refused = () => new HttpError(401, 'Unauthorized', { error: 'Unauthorized', statusCode: 401 });

beforeEach(() => {
  verifyPassword.mockClear();
  federationCredential.mockClear();
  getFederationRegistry.mockReset();
  getFederationRegistry.mockResolvedValue({ registry: [], updatedAt: 0 });
  putFederationRegistry.mockClear();
  ensurePeered.mockClear();
  connectInstance.mockClear();
  remoteRegister.mockReset();
  remoteLogin.mockReset();
  remoteMe.mockReset();
  remoteInfo.mockClear();
  localStorage.clear();
  session.user = HOME_USER;
  useInstanceStore.setState({
    instances: [],
    registry: new Map(),
    registryUpdatedAt: 0,
    isLoading: false,
    error: null,
    _autoConnectDone: false,
    _registrySyncReady: false,
  });
  Object.defineProperty(window, 'location', { value: new URL('https://nova.example/'), writable: true });
});

describe('a connection moves both of its projections together', () => {
  it('a fresh connect leaves both halves connected', async () => {
    seed('error', 'auth_expired');
    remoteRegister.mockResolvedValue({ token: 'new-token', user: remoteUser() });

    await useInstanceStore.getState().connectToRemote(REMOTE, 'home-password', 'Erin');

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'connected', registry: 'connected' });
  });

  it('a connect the remote refuses leaves the placeholder as it stood, in agreement', async () => {
    seed('error', 'auth_expired');
    remoteRegister.mockRejectedValue(
      new HttpError(409, 'Username is already taken', { error: 'Username is already taken', code: 'username_taken', statusCode: 409 }, 'username_taken'),
    );
    remoteLogin.mockRejectedValue(new HttpError(401, 'Unauthorized', { error: 'Unauthorized', statusCode: 401 }));

    await expect(useInstanceStore.getState().connectToRemote(REMOTE, 'wrong-password')).rejects.toThrow();

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'error', registry: 'auth_expired' });
    expect(useInstanceStore.getState().isLoading).toBe(false);
  });

  it('an explicit per-instance login leaves both halves connected', async () => {
    seed('error', 'auth_expired');
    remoteLogin.mockResolvedValue({ token: 'new-token', user: remoteUser({ username: 'erin' }) });

    await useInstanceStore.getState().loginToRemote(REMOTE, 'erin', 'their-own-password');

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'connected', registry: 'connected' });
  });

  it('disconnecting by hand leaves both halves disconnected', () => {
    seed('connected', 'connected');

    useInstanceStore.getState().disconnectInstance(REMOTE);

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'disconnected', registry: 'disconnected' });
  });

  it('a token reconnect leaves both halves connected', async () => {
    seed('disconnected', 'unreachable');
    remoteMe.mockResolvedValue(remoteUser());

    await useInstanceStore.getState().reconnectInstance(REMOTE);

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'connected', registry: 'connected' });
  });

  it('a reconnect to an instance that does not answer leaves both halves unreachable', async () => {
    seed('disconnected', 'connected');
    remoteMe.mockRejectedValue(unreachable());

    await useInstanceStore.getState().reconnectInstance(REMOTE);

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'disconnected', registry: 'unreachable' });
    expect(useInstanceStore.getState().registry.get(REMOTE)?.errorMessage).toBe('unreachable');
  });

  it('a reconnect the instance refuses leaves both halves expired', async () => {
    seed('disconnected', 'connected');
    remoteMe.mockRejectedValue(refused());

    await useInstanceStore.getState().reconnectInstance(REMOTE);

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'error', registry: 'auth_expired' });
    expect(useInstanceStore.getState().registry.get(REMOTE)?.errorMessage).toBe('session_expired');
  });
});

describe('autoConnectAll moves both projections together too', () => {
  beforeEach(() => {
    session.user = { ...HOME_USER, replicatedInstances: [{ origin: REMOTE, username: 'erin@nova.example' }] };
    getFederationRegistry.mockResolvedValue({ registry: [registryEntry('connected')], updatedAt: 500 });
  });

  it('a known connection with no cached token starts expired on both halves', async () => {
    await useInstanceStore.getState().autoConnectAll();

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'error', registry: 'auth_expired' });
    expect(useInstanceStore.getState().registry.get(REMOTE)?.errorMessage).toBe('session_expired');
  });

  it('a cached token that still works leaves both halves connected', async () => {
    cacheToken('cached-token');
    remoteMe.mockResolvedValue(remoteUser());

    await useInstanceStore.getState().autoConnectAll();

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'connected', registry: 'connected' });
    expect(connectInstance).toHaveBeenCalledWith(REMOTE, 'cached-token');
  });

  it('a cached token on an instance that does not answer leaves both halves unreachable', async () => {
    cacheToken('cached-token');
    remoteMe.mockRejectedValue(unreachable());

    await useInstanceStore.getState().autoConnectAll();

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'disconnected', registry: 'unreachable' });
  });

  it('a cached token the instance refuses leaves both halves expired', async () => {
    cacheToken('cached-token');
    remoteMe.mockRejectedValue(refused());

    await useInstanceStore.getState().autoConnectAll();

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'error', registry: 'auth_expired' });
  });

  it('a connection the user disconnected is placed without reopening it, and keeps the time it went', async () => {
    cacheToken('cached-token');
    getFederationRegistry.mockResolvedValue({
      registry: [registryEntry('disconnected', { disconnectedAt: 4_000 })],
      updatedAt: 500,
    });

    await useInstanceStore.getState().autoConnectAll();

    expect(agreedStatuses(REMOTE)).toEqual({ live: 'disconnected', registry: 'disconnected' });
    // The row records when the user disconnected, not when the app started.
    expect(useInstanceStore.getState().registry.get(REMOTE)?.disconnectedAt).toBe(4_000);
    expect(remoteMe).not.toHaveBeenCalled();
    expect(connectInstance).not.toHaveBeenCalled();
  });
});

describe('the socket layer moves the live half only', () => {
  it('a websocket drop does not mark the registry entry disconnected', () => {
    seed('connected', 'connected');
    const before = useInstanceStore.getState().registry.get(REMOTE);

    useInstanceStore.getState().setInstanceStatus(REMOTE, 'disconnected', 'Connection lost — reconnecting');

    const state = useInstanceStore.getState();
    expect(state.instances[0]?.status).toBe('disconnected');
    expect(state.instances[0]?.error).toBe('Connection lost — reconnecting');
    // A blip must not leave the row the user disconnected: that row is what
    // suppresses auto-connect on the next launch.
    expect(state.registry.get(REMOTE)).toEqual(before);
    expect(state.registryUpdatedAt).toBe(0);
  });

  it('a websocket that comes back does not restamp the registry entry', () => {
    seed('connecting', 'connected');
    const before = useInstanceStore.getState().registry.get(REMOTE);

    useInstanceStore.getState().setInstanceStatus(REMOTE, 'connected');

    expect(useInstanceStore.getState().instances[0]?.status).toBe('connected');
    expect(useInstanceStore.getState().registry.get(REMOTE)).toEqual(before);
    expect(useInstanceStore.getState().registryUpdatedAt).toBe(0);
  });
});
