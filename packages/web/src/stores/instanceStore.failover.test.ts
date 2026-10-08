import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../hooks/useWebSocket', () => ({
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));
// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
// Stub authStore to avoid localStorage access during module init
vi.mock('./authStore', async () => {
  const state = { user: null, token: null };
  return (await import('../test/authStoreMock')).authStoreMock(() => state);
});

import { useInstanceStore } from './instanceStore';
import type { ConnectedInstance } from './instanceStore';
import { useSpaceStore } from './spaceStore';
import { useSocialStore } from './socialStore';
import type { DmChannel, Friend } from '@backspace/shared';

let mockFailover: ReturnType<typeof vi.spyOn>;

function inst(origin: string, status: ConnectedInstance['status']): ConnectedInstance {
  return {
    origin, label: origin, token: 'tok', username: 'u', status,
    user: { id: 'u', username: 'u' } as any,
    api: {} as any,
  };
}

beforeEach(() => {
  mockFailover?.mockRestore();
  useSpaceStore.getState().reset();
  // A socket that drops makes the origin unavailable to the DM pin rule.
  mockFailover = vi.spyOn(useSpaceStore.getState(), 'setDmOriginAvailable');
  useInstanceStore.setState({ instances: [], registry: new Map(), registryUpdatedAt: 0 });
});

function dm(id: string, federatedId: string): DmChannel {
  return { id, federatedId, createdAt: 1, members: [] };
}

describe('instanceStore failover triggers', () => {
  it('fires failover on connected → disconnected transition', () => {
    useInstanceStore.setState({ instances: [inst('https://b.example', 'connected')] });
    useInstanceStore.getState().setInstanceStatus('https://b.example', 'disconnected');
    expect(mockFailover).toHaveBeenCalledExactlyOnceWith('https://b.example', false);
  });

  it('fires failover on connected → error transition', () => {
    useInstanceStore.setState({ instances: [inst('https://b.example', 'connected')] });
    useInstanceStore.getState().setInstanceStatus('https://b.example', 'error');
    expect(mockFailover).toHaveBeenCalledExactlyOnceWith('https://b.example', false);
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

  it('disconnectInstance moves a DM pinned to the origin onto another connected copy', () => {
    // b.example's copy was listed first; c.example holds another copy.
    useSpaceStore.getState().populateFromReady('https://b.example', [], [], [dm('b-1', 'fed-aaa')]);
    useSpaceStore.getState().populateFromReady('https://c.example', [], [], [dm('c-1', 'fed-aaa')]);
    expect(useSpaceStore.getState().dmChannels.map(d => d.id)).toEqual(['b-1']);

    useInstanceStore.setState({ instances: [inst('https://b.example', 'connected'), inst('https://c.example', 'connected')] });
    useInstanceStore.getState().disconnectInstance('https://b.example');

    expect(useSpaceStore.getState().dmChannels.map(d => d.id)).toEqual(['c-1']);
    expect(useSpaceStore.getState().channelOriginMap.get('c-1')).toBe('https://c.example');
  });

  it('forceRemoveEntry moves a DM pinned to the origin onto another copy and drops the ones with none', () => {
    useSpaceStore.getState().populateFromReady('https://b.example', [], [], [dm('b-1', 'fed-aaa'), dm('b-2', 'fed-bbb')]);
    useSpaceStore.getState().populateFromReady('', [], [], [dm('home-1', 'fed-aaa')]);

    useInstanceStore.setState({ instances: [inst('https://b.example', 'connected')] });
    useInstanceStore.getState().forceRemoveEntry('https://b.example');

    expect(useSpaceStore.getState().dmChannels.map(d => d.id)).toEqual(['home-1']);
  });

  describe("an instance's friends and requests", () => {
    function friendRow(id: string, origin: string): Friend & { _instanceOrigin: string } {
      return {
        id, username: id, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null, bio: null,
        status: 'online', customStatus: null, isAdmin: false, createdAt: 1, addedAt: 1,
        homeInstance: null, homeUserId: id, replicatedInstances: [], _instanceOrigin: origin,
      } as Friend & { _instanceOrigin: string };
    }

    beforeEach(() => {
      useSocialStore.getState().reset();
      useSocialStore.setState({ friends: [friendRow('f-home', ''), friendRow('f-b', 'https://b.example')] });
      useInstanceStore.setState({ instances: [inst('https://b.example', 'connected')] });
    });

    it('disconnectInstance drops the rows that instance listed', () => {
      useInstanceStore.getState().disconnectInstance('https://b.example');
      expect(useSocialStore.getState().friends.map(f => f.id)).toEqual(['f-home']);
    });

    it('forceRemoveEntry drops the rows that instance listed', () => {
      useInstanceStore.getState().forceRemoveEntry('https://b.example');
      expect(useSocialStore.getState().friends.map(f => f.id)).toEqual(['f-home']);
    });

    it('a socket that drops keeps them: the instance is still held', () => {
      useInstanceStore.getState().setInstanceStatus('https://b.example', 'disconnected');
      expect(useSocialStore.getState().friends.map(f => f.id)).toEqual(['f-home', 'f-b']);
    });
  });
});
