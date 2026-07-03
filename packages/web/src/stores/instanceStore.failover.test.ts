import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockFailover = vi.fn();
vi.mock('../utils/dmOriginFailover', () => ({
  failoverDmOriginsFromDisconnected: (o: string) => mockFailover(o),
}));
vi.mock('../hooks/useWebSocket', () => ({
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));
vi.mock('../utils/federationOps', () => ({ clearPasswordSyncTimers: vi.fn() }));
// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
// Stub authStore to avoid localStorage access during module init
vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    { getState: () => ({ user: null, token: null }), setState: vi.fn(), subscribe: vi.fn() }
  ),
}));

import { useInstanceStore } from './instanceStore';
import type { ConnectedInstance } from './instanceStore';

function inst(origin: string, status: ConnectedInstance['status']): ConnectedInstance {
  return {
    origin, label: origin, token: 'tok', username: 'u', status,
    user: { id: 'u', username: 'u' } as any,
    api: {} as any,
  };
}

beforeEach(() => {
  mockFailover.mockClear();
  useInstanceStore.setState({ instances: [], registry: new Map(), registryUpdatedAt: 0 });
});

describe('instanceStore failover triggers', () => {
  it('fires failover on connected → disconnected transition', () => {
    useInstanceStore.setState({ instances: [inst('https://b.example', 'connected')] });
    useInstanceStore.getState().setInstanceStatus('https://b.example', 'disconnected');
    expect(mockFailover).toHaveBeenCalledExactlyOnceWith('https://b.example');
  });

  it('fires failover on connected → error transition', () => {
    useInstanceStore.setState({ instances: [inst('https://b.example', 'connected')] });
    useInstanceStore.getState().setInstanceStatus('https://b.example', 'error');
    expect(mockFailover).toHaveBeenCalledExactlyOnceWith('https://b.example');
  });

  it('does not fire on connecting → connected', () => {
    useInstanceStore.setState({ instances: [inst('https://b.example', 'connecting')] });
    useInstanceStore.getState().setInstanceStatus('https://b.example', 'connected');
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('does not fire on disconnected → error (no connected source)', () => {
    useInstanceStore.setState({ instances: [inst('https://b.example', 'disconnected')] });
    useInstanceStore.getState().setInstanceStatus('https://b.example', 'error');
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('does not fire when instance is not in the list', () => {
    useInstanceStore.getState().setInstanceStatus('https://unknown.example', 'disconnected');
    expect(mockFailover).not.toHaveBeenCalled();
  });

  it('disconnectInstance runs failover before removeInstanceSpaces', async () => {
    // Seed a DM pinned to b.example with home as alternative — removeInstanceSpaces
    // uses spaceStore, which we let run; we just check failover ran first (call order).
    const spaceModule = await import('./spaceStore');
    const spaceSpy = vi.spyOn(spaceModule.useSpaceStore.getState(), 'removeInstanceSpaces');
    const callOrder: string[] = [];
    mockFailover.mockImplementation(() => { callOrder.push('failover'); });
    spaceSpy.mockImplementation(() => { callOrder.push('removeInstanceSpaces'); });

    useInstanceStore.setState({ instances: [inst('https://b.example', 'connected')] });
    useInstanceStore.getState().disconnectInstance('https://b.example');
    await Promise.resolve();

    expect(callOrder).toEqual(['failover', 'removeInstanceSpaces']);
    spaceSpy.mockRestore();
  });

  it('forceRemoveEntry runs failover before removeInstanceSpaces', async () => {
    const spaceModule = await import('./spaceStore');
    const spaceSpy = vi.spyOn(spaceModule.useSpaceStore.getState(), 'removeInstanceSpaces');
    const callOrder: string[] = [];
    mockFailover.mockImplementation(() => { callOrder.push('failover'); });
    spaceSpy.mockImplementation(() => { callOrder.push('removeInstanceSpaces'); });

    useInstanceStore.setState({ instances: [inst('https://b.example', 'connected')] });
    useInstanceStore.getState().forceRemoveEntry('https://b.example');
    await Promise.resolve();

    expect(callOrder).toEqual(['failover', 'removeInstanceSpaces']);
    spaceSpy.mockRestore();
  });
});
