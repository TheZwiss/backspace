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

// Spy-able getApiForOrigin: returns a remote-flavoured client when given a
// non-empty origin, the home stub otherwise. Used to assert which origin
// owner-only DM calls route to. We mock the resolver module directly so the
// real api/client.ts (which imports it) ends up calling our spy at runtime.
// Hoisted via vi.hoisted so the factory below — which is itself hoisted
// above the rest of the file — can reference the spies without TDZ errors.
const { remoteClient, homeClient, mockGetApiForOrigin } = vi.hoisted(() => {
  const remote = {
    dm: {
      updateMetadata: vi.fn().mockResolvedValue({}),
      kickMember: vi.fn().mockResolvedValue({}),
      transferOwnership: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockResolvedValue({}),
    },
  };
  const home = {
    dm: {
      updateMetadata: vi.fn().mockResolvedValue({}),
      kickMember: vi.fn().mockResolvedValue({}),
      transferOwnership: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockResolvedValue({}),
    },
  };
  return {
    remoteClient: remote,
    homeClient: home,
    mockGetApiForOrigin: vi.fn((origin: string) =>
      origin ? (remote as never) : (home as never),
    ),
  };
});

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

describe('group DM owner routing — api.dm.* (Task 5.2)', () => {
  it('baseline (no transfer): owner-only ops route to home (empty origin)', async () => {
    useSpaceStore.setState({ dmChannels: [{ ...baseDm }] });

    await api.dm.updateMetadata('dm-1', { name: 'X' });

    expect(mockGetApiForOrigin).toHaveBeenCalledWith('');
    // Home client is returned for empty origin; the singleton delegates to it,
    // and the spy on homeClient.dm.updateMetadata records the call.
    expect(homeClient.dm.updateMetadata).toHaveBeenCalledWith('dm-1', { name: 'X' });
    expect(remoteClient.dm.updateMetadata).not.toHaveBeenCalled();
  });

  it('after transfer: api.dm.updateMetadata routes to new owner instance', async () => {
    useSpaceStore.setState({
      dmChannels: [{ ...baseDm, ownerHomeInstance: 'https://orbit.test' }],
    });

    await api.dm.updateMetadata('dm-1', { name: 'Renamed' });

    expect(mockGetApiForOrigin).toHaveBeenCalledWith('https://orbit.test');
    expect(remoteClient.dm.updateMetadata).toHaveBeenCalledWith('dm-1', { name: 'Renamed' });
  });

  it('after transfer: api.dm.kickMember routes to new owner instance', async () => {
    useSpaceStore.setState({
      dmChannels: [{ ...baseDm, ownerHomeInstance: 'https://orbit.test' }],
    });

    await api.dm.kickMember('dm-1', 'target-user');

    expect(mockGetApiForOrigin).toHaveBeenCalledWith('https://orbit.test');
    // Third arg is the optional federated identity (undefined when target is local)
    expect(remoteClient.dm.kickMember).toHaveBeenCalledWith('dm-1', 'target-user', undefined);
  });

  it('after transfer: api.dm.kickMember forwards federated identity when supplied', async () => {
    useSpaceStore.setState({
      dmChannels: [{ ...baseDm, ownerHomeInstance: 'https://orbit.test' }],
    });

    await api.dm.kickMember('dm-1', 'target-user', {
      homeUserId: 'target-home-id',
      homeInstance: 'https://orbit.test',
    });

    expect(mockGetApiForOrigin).toHaveBeenCalledWith('https://orbit.test');
    expect(remoteClient.dm.kickMember).toHaveBeenCalledWith('dm-1', 'target-user', {
      homeUserId: 'target-home-id',
      homeInstance: 'https://orbit.test',
    });
  });

  it('after transfer: api.dm.transferOwnership routes to new owner instance', async () => {
    useSpaceStore.setState({
      dmChannels: [{ ...baseDm, ownerHomeInstance: 'https://orbit.test' }],
    });

    await api.dm.transferOwnership('dm-1', 'next-owner');

    expect(mockGetApiForOrigin).toHaveBeenCalledWith('https://orbit.test');
    expect(remoteClient.dm.transferOwnership).toHaveBeenCalledWith('dm-1', 'next-owner', undefined);
  });

  it('after transfer: api.dm.transferOwnership forwards federated identity when supplied', async () => {
    useSpaceStore.setState({
      dmChannels: [{ ...baseDm, ownerHomeInstance: 'https://orbit.test' }],
    });

    await api.dm.transferOwnership('dm-1', 'next-owner', {
      homeUserId: 'next-owner-home-id',
      homeInstance: 'https://orbit.test',
    });

    expect(mockGetApiForOrigin).toHaveBeenCalledWith('https://orbit.test');
    expect(remoteClient.dm.transferOwnership).toHaveBeenCalledWith('dm-1', 'next-owner', {
      homeUserId: 'next-owner-home-id',
      homeInstance: 'https://orbit.test',
    });
  });

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
    useSpaceStore.setState({
      dmChannels: [{
        ...baseDm,
        ownerId: 'old-owner',
        ownerHomeUserId: 'old-owner-home',
        ownerHomeInstance: 'https://nova.test',
      }],
    });

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
    useSpaceStore.setState({
      dmChannels: [{
        ...baseDm,
        ownerId: 'old-owner',
        ownerHomeUserId: 'old-owner-home',
        ownerHomeInstance: 'https://nova.test',
      }],
    });

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
