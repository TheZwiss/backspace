import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { User } from '@backspace/shared';
import type { BackspaceApiClient } from '../api/client';

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: {
    users: {
      getFederationRegistry: vi.fn(async () => ({ registry: [], updatedAt: 0 })),
      putFederationRegistry: vi.fn(async () => ({ ok: true, updatedAt: 1 })),
    },
    federation: { ensurePeered: vi.fn(async () => ({ peeringStatus: 'active' })) },
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
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

const NATIVE_USER: Partial<User> = {
  id: 'user-1',
  username: 'erin',
  displayName: 'Erin',
  homeInstance: null,
  homeUserId: 'user-1',
  replicatedInstances: [],
};
vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: NATIVE_USER, token: 'tok' }),
    { getState: () => ({ user: NATIVE_USER, token: 'tok' }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

import { useInstanceStore, connectToInstance, DifferentPasswordError } from './instanceStore';
import type { ConnectedInstance } from './instanceStore';

const REMOTE = 'https://orbit.example';

function makeInstance(overrides: Partial<ConnectedInstance> = {}): ConnectedInstance {
  return {
    origin: REMOTE,
    label: 'Orbit',
    token: 'old-token',
    username: 'erin@nova.example',
    status: 'connected',
    user: {
      id: 'remote-1', username: 'erin@nova.example',
      homeInstance: 'nova.example', homeUserId: 'user-1',
    } as User,
    api: {} as BackspaceApiClient,
    ...overrides,
  };
}

const connectToRemote = vi.fn(async (_origin: string, _password: string, _displayName?: string) => {});
const reauthenticateInstance = vi.fn(async (_origin: string, _password: string) => {});

beforeEach(() => {
  connectToRemote.mockReset();
  reauthenticateInstance.mockReset();
  useInstanceStore.setState({
    instances: [],
    connectToRemote,
    reauthenticateInstance,
  });
  Object.defineProperty(window, 'location', {
    value: new URL('https://nova.example/'),
    writable: true,
  });
});

describe('connectToInstance', () => {
  it('reauthenticates an instance the store knows in the error state', async () => {
    useInstanceStore.setState({ instances: [makeInstance({ status: 'error', error: 'Token expired' })] });

    const outcome = await connectToInstance('orbit.example/', 'pw');

    expect(outcome).toEqual({ kind: 'connected', how: 'reconnect' });
    expect(reauthenticateInstance).toHaveBeenCalledWith(REMOTE, 'pw');
    expect(connectToRemote).not.toHaveBeenCalled();
  });

  it('reauthenticates an instance the store knows in the disconnected state', async () => {
    useInstanceStore.setState({ instances: [makeInstance({ status: 'disconnected' })] });

    const outcome = await connectToInstance(REMOTE, 'pw');

    expect(outcome).toEqual({ kind: 'connected', how: 'reconnect' });
    expect(reauthenticateInstance).toHaveBeenCalledWith(REMOTE, 'pw');
  });

  it('short-circuits a connected instance without touching the store', async () => {
    useInstanceStore.setState({ instances: [makeInstance({ status: 'connected' })] });

    const outcome = await connectToInstance('orbit.example/', 'pw', 'Erin');

    expect(outcome).toEqual({ kind: 'connected', how: 'already' });
    expect(connectToRemote).not.toHaveBeenCalled();
    expect(reauthenticateInstance).not.toHaveBeenCalled();
  });

  it('short-circuits a connecting instance without touching the store', async () => {
    useInstanceStore.setState({ instances: [makeInstance({ status: 'connecting' })] });

    const outcome = await connectToInstance(REMOTE, 'pw');

    expect(outcome).toEqual({ kind: 'connected', how: 'already' });
    expect(connectToRemote).not.toHaveBeenCalled();
    expect(reauthenticateInstance).not.toHaveBeenCalled();
  });

  it('connects an unknown origin, canonicalised', async () => {
    const outcome = await connectToInstance('Orbit.Example/some/path', 'pw');

    expect(outcome).toEqual({ kind: 'connected', how: 'new' });
    expect(connectToRemote).toHaveBeenCalledWith(REMOTE, 'pw', undefined);
    expect(reauthenticateInstance).not.toHaveBeenCalled();
  });

  it('maps DifferentPasswordError to needs-remote-password', async () => {
    connectToRemote.mockRejectedValueOnce(new DifferentPasswordError('erin@nova.example'));

    const outcome = await connectToInstance(REMOTE, 'pw');

    expect(outcome).toEqual({ kind: 'needs-remote-password', remoteUsername: 'erin@nova.example' });
  });

  it('maps DifferentPasswordError from the reconnect path too', async () => {
    useInstanceStore.setState({ instances: [makeInstance({ status: 'error' })] });
    reauthenticateInstance.mockRejectedValueOnce(new DifferentPasswordError('erin@nova.example'));

    const outcome = await connectToInstance(REMOTE, 'pw');

    expect(outcome).toEqual({ kind: 'needs-remote-password', remoteUsername: 'erin@nova.example' });
  });

  it('rethrows every other error', async () => {
    connectToRemote.mockRejectedValueOnce(new Error('Incorrect password'));

    await expect(connectToInstance(REMOTE, 'pw')).rejects.toThrow('Incorrect password');
  });

  it('rejects an origin that does not parse before touching the store', async () => {
    await expect(connectToInstance('http://', 'pw')).rejects.toThrow('Invalid URL');
    expect(connectToRemote).not.toHaveBeenCalled();
  });
});
