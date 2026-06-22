import { describe, it, expect, beforeEach, vi } from 'vitest';

const getFederationRegistry = vi.fn();
const putFederationRegistry = vi.fn(async () => ({ ok: true, updatedAt: 1 }));
const ensurePeered = vi.fn(async () => ({ peeringStatus: 'active' }));

vi.mock('../api/client', () => ({
  api: {
    users: {
      getFederationRegistry: () => getFederationRegistry(),
      putFederationRegistry: (data: unknown) => putFederationRegistry(data),
      me: vi.fn(),
    },
    federation: {
      ensurePeered: (data: unknown) => ensurePeered(data),
    },
  },
  createApiClient: () => ({}),
}));

vi.mock('../hooks/useWebSocket', () => ({
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));
vi.mock('../utils/dmOriginFailover', () => ({
  failoverDmOriginsFromDisconnected: vi.fn(),
}));
vi.mock('../utils/federationOps', () => ({ clearPasswordSyncTimers: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

const mockUser = {
  id: 'user-1',
  username: 'erin',
  homeInstance: null,
  homeUserId: 'user-1',
  replicatedInstances: [
    { origin: 'https://orbit.example', username: 'erin@nova.example' },
  ],
};

vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: mockUser, token: 'tok' }),
    { getState: () => ({ user: mockUser, token: 'tok' }), setState: vi.fn(), subscribe: vi.fn() }
  ),
}));

import { useInstanceStore } from './instanceStore';

beforeEach(() => {
  getFederationRegistry.mockReset();
  putFederationRegistry.mockClear();
  ensurePeered.mockClear();
  localStorage.clear();
  useInstanceStore.setState({
    instances: [],
    registry: new Map(),
    registryUpdatedAt: 0,
    _autoConnectDone: false,
    _registrySyncReady: false,
    pendingSyncOrigins: [],
  });
});

describe('instanceStore registry sync gating', () => {
  it('does NOT PUT registry when initial GET fails (prevents empty-clobber)', async () => {
    getFederationRegistry.mockRejectedValueOnce(new Error('network'));

    await useInstanceStore.getState().autoConnectAll();

    expect(putFederationRegistry).not.toHaveBeenCalled();
    expect(useInstanceStore.getState()._registrySyncReady).toBe(false);
  });

  it('synthesizes replicatedInstances entries when GET fails so UI is not empty', async () => {
    getFederationRegistry.mockRejectedValueOnce(new Error('network'));

    await useInstanceStore.getState().autoConnectAll();

    const reg = useInstanceStore.getState().registry;
    expect(reg.has('https://orbit.example')).toBe(true);
    expect(reg.get('https://orbit.example')?.status).toBe('auth_expired');
  });

  it('PUTs registry after a successful initial GET and flips _registrySyncReady', async () => {
    getFederationRegistry.mockResolvedValueOnce({
      registry: [{
        origin: 'https://orbit.example',
        label: 'Orbit',
        username: 'erin@nova.example',
        remoteUserId: 'remote-1',
        status: 'auth_expired',
        addedAt: 1,
        lastConnectedAt: 1,
        disconnectedAt: null,
        errorMessage: null,
      }],
      updatedAt: 100,
    });

    await useInstanceStore.getState().autoConnectAll();

    expect(useInstanceStore.getState()._registrySyncReady).toBe(true);
    expect(putFederationRegistry).toHaveBeenCalledTimes(1);
    const payload = putFederationRegistry.mock.calls[0]![0] as { registry: unknown[] };
    expect(payload.registry).toHaveLength(1);
  });

  it('syncRegistry no-ops while _registrySyncReady is false (post-failure mutation)', async () => {
    getFederationRegistry.mockRejectedValueOnce(new Error('network'));
    await useInstanceStore.getState().autoConnectAll();
    putFederationRegistry.mockClear();

    useInstanceStore.setState({
      registry: new Map([['https://other.example', {
        origin: 'https://other.example',
        label: 'Other', username: 'u', remoteUserId: '',
        status: 'connected' as const,
        addedAt: 1, lastConnectedAt: 1, disconnectedAt: null, errorMessage: null,
      }]]),
      registryUpdatedAt: Date.now(),
    });

    await useInstanceStore.getState().syncRegistry();

    expect(putFederationRegistry).not.toHaveBeenCalled();
  });

  it('reset clears _registrySyncReady', async () => {
    getFederationRegistry.mockResolvedValueOnce({ registry: [], updatedAt: 1 });
    await useInstanceStore.getState().autoConnectAll();
    expect(useInstanceStore.getState()._registrySyncReady).toBe(true);

    useInstanceStore.getState().reset();

    expect(useInstanceStore.getState()._registrySyncReady).toBe(false);
  });
});
