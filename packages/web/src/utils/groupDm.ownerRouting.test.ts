import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub AudioManager (jsdom has no AudioWorkletNode)
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Stub instanceStore + authStore to avoid init-order issues
vi.mock('../stores/instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ instances: [], _autoConnectDone: true }),
    {
      getState: () => ({ instances: [], _autoConnectDone: true }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    {
      getState: () => ({ user: null, token: null }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

import { useSpaceStore, getOwnerInstanceForDm, getChannelOrigin } from '../stores/spaceStore';

const baseDm = {
  id: 'dm-1',
  federatedId: null,
  ownerId: 'U1',
  ownerHomeUserId: 'U1',
  ownerHomeInstance: '' as string | null,
  createdAt: 1,
  members: [],
  lastMessage: null,
  name: null,
  icon: null,
  metadataUpdatedAt: 0,
};

beforeEach(() => {
  useSpaceStore.getState().reset();
});

describe('getOwnerInstanceForDm — helper', () => {
  it('returns "" for an unknown channel id', () => {
    expect(getOwnerInstanceForDm('does-not-exist')).toBe('');
  });

  it('returns "" for a DM with home-instance owner (ownerHomeInstance = "")', () => {
    useSpaceStore.setState({ dmChannels: [{ ...baseDm, ownerHomeInstance: '' }] });
    expect(getOwnerInstanceForDm('dm-1')).toBe('');
  });

  it('returns "" when ownerHomeInstance is null (legacy / non-group DM)', () => {
    useSpaceStore.setState({ dmChannels: [{ ...baseDm, ownerHomeInstance: null }] });
    expect(getOwnerInstanceForDm('dm-1')).toBe('');
  });

  it('returns the remote origin after a transfer mutates ownerHomeInstance', () => {
    useSpaceStore.setState({
      dmChannels: [{ ...baseDm, ownerHomeInstance: 'https://orbit.test' }],
    });
    expect(getOwnerInstanceForDm('dm-1')).toBe('https://orbit.test');
  });

  it('is distinct from getChannelOrigin (channel-pinned origin can differ)', () => {
    useSpaceStore.setState({
      dmChannels: [{ ...baseDm, ownerHomeInstance: 'https://orbit.test' }],
      // channelOriginMap is the channel's pinned serving origin — independent
      // of ownerHomeInstance after a manual ownership transfer.
      channelOriginMap: new Map([['dm-1', 'https://nova.test']]),
    });
    expect(getChannelOrigin('dm-1')).toBe('https://nova.test');
    expect(getOwnerInstanceForDm('dm-1')).toBe('https://orbit.test');
  });
});
