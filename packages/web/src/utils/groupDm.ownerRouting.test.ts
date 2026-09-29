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

// Spy-able getApiForOrigin, so the sendMessage test below can assert that
// a non-owner request never consults the owner's instance.
const { mockGetApiForOrigin } = vi.hoisted(() => ({
  mockGetApiForOrigin: vi.fn(() => ({ dm: {} }) as never),
}));

vi.mock('./crossStoreResolvers', async () => {
  const actual = await vi.importActual<typeof import('./crossStoreResolvers')>('./crossStoreResolvers');
  return {
    ...actual,
    getApiForOrigin: mockGetApiForOrigin,
  };
});

import { useSpaceStore, getOwnerInstanceForDm, getChannelOrigin } from '../stores/spaceStore';
import { api } from '../api/client';

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
  vi.clearAllMocks();
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

// Which instance an owner-only request goes to, and how it names the
// conversation and the member there, is `groupDmOwnerActions.test.ts`.
describe('group DM owner routing — the owner instance the store keeps', () => {
  it('updateDmOwner keeps ownerHomeInstance in sync so the next owner-only op routes correctly', () => {
    // Regression: the `dm_owner_updated` WS handler used to call
    // updateDmOwner(channelId, newOwnerId) without the home-identity fields.
    // After a manual back-and-forth transfer, `getOwnerInstanceForDm` then
    // returned the PREVIOUS owner's home origin — the next owner-only call
    // routed to the wrong instance and the receiver rejected the resulting
    // federation event with `unauthorized_source`.
    //
    // The fix: WS event carries `newOwnerHomeUserId` + `newOwnerHomeInstance`
    // and the store writes them. This test pins that behavior down.
    const { updateDmOwner } = useSpaceStore.getState();
    useSpaceStore.getState().populateFromReady('', [], [], [{
      ...baseDm,
      ownerId: 'old-owner',
      ownerHomeUserId: 'old-owner-home',
      ownerHomeInstance: 'https://nova.test',
    }]);

    updateDmOwner('dm-1', 'new-owner', 'new-owner-home', 'https://orbit.test');

    const dm = useSpaceStore.getState().dmChannels.find(d => d.id === 'dm-1');
    expect(dm?.ownerId).toBe('new-owner');
    expect(dm?.ownerHomeUserId).toBe('new-owner-home');
    expect(dm?.ownerHomeInstance).toBe('https://orbit.test');
    expect(getOwnerInstanceForDm('dm-1')).toBe('https://orbit.test');
  });

  it('updateDmOwner does NOT clear existing federation routing fields when called without them (legacy server)', () => {
    // An older server that hasn't shipped the WS payload extension yet would
    // call updateDmOwner with only (channelId, newOwnerId). The store must
    // not blank out the existing home fields, or `getOwnerInstanceForDm`
    // would silently fall back to '' (home) — re-introducing the bug.
    const { updateDmOwner } = useSpaceStore.getState();
    useSpaceStore.getState().populateFromReady('', [], [], [{
      ...baseDm,
      ownerId: 'old-owner',
      ownerHomeUserId: 'old-owner-home',
      ownerHomeInstance: 'https://nova.test',
    }]);

    updateDmOwner('dm-1', 'new-owner');

    const dm = useSpaceStore.getState().dmChannels.find(d => d.id === 'dm-1');
    expect(dm?.ownerId).toBe('new-owner');
    expect(dm?.ownerHomeUserId).toBe('old-owner-home');
    expect(dm?.ownerHomeInstance).toBe('https://nova.test');
  });

  it('non-owner-only op (sendMessage) is unaffected by ownerHomeInstance', async () => {
    // Owner routing is opt-in per method — sendMessage on the singleton api
    // must NOT consult ownerHomeInstance. It uses the channel's pinned origin
    // resolved by the caller (via getChannelOrigin), not the owner instance.
    useSpaceStore.setState({
      dmChannels: [{ ...baseDm, ownerHomeInstance: 'https://orbit.test' }],
    });

    // Mock fetch so sendMessage doesn't try a real network call.
    const originalFetch = global.fetch;
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await api.dm.sendMessage('dm-1', { content: 'hi' });
    } finally {
      global.fetch = originalFetch;
    }

    expect(mockGetApiForOrigin).not.toHaveBeenCalledWith('https://orbit.test');
  });
});
