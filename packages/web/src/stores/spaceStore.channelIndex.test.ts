import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Channel, DmChannel, SpaceWithChannelsAndMembers } from '@backspace/shared';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

vi.mock('./instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ instances: [], _autoConnectDone: true }),
    {
      getState: () => ({ instances: [], _autoConnectDone: true }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('./authStore', async () => {
  const state = { user: null, token: null };
  return (await import('../test/authStoreMock')).authStoreMock(() => state);
});

import { useSpaceStore, isDmChannel, getChannelKind, useIsDmChannel, type TaggedSpace } from './spaceStore';
import { api } from '../api/client';

const NOVA = 'https://nova.example';

function channel(id: string, spaceId: string, fields: Partial<Channel> = {}): Channel {
  return {
    id, spaceId, name: id, type: 'text', topic: null, position: 0, categoryId: null, createdAt: 1,
    myPermissions: '1', ...fields,
  };
}

function space(id: string, channels: Channel[]): SpaceWithChannelsAndMembers {
  return {
    id, name: id, icon: null, banner: null, avatarColor: null, ownerId: 'o', inviteCode: null,
    visibility: 'private', directoryListed: false, description: null, createdAt: 1,
    channels, categories: [], members: [], roles: [], myPermissions: '1',
  };
}

function tagged(id: string, origin: string): TaggedSpace {
  return {
    id, name: id, icon: null, banner: null, avatarColor: null, ownerId: 'o', inviteCode: null,
    visibility: 'private', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: origin,
  };
}

function dm(id: string): DmChannel {
  return { id, federatedId: null, createdAt: 1, members: [] };
}

beforeEach(() => {
  useSpaceStore.getState().reset();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('the channel index is the one source of the space-channel lookup maps', () => {
  it('addSpaceFromReady registers its voice channels', () => {
    useSpaceStore.getState().addSpaceFromReady(NOVA, space('s1', [channel('v1', 's1', { type: 'voice' })]));
    const s = useSpaceStore.getState();
    expect(s.voiceChannelIds.has('v1')).toBe(true);
    expect(s.spaceChannelIndex.get('v1')).toEqual({ spaceId: 's1', origin: NOVA, type: 'voice' });
  });

  it('removeSpace forgets the voice channels of that space', () => {
    useSpaceStore.getState().populateFromReady(NOVA, [space('s1', [channel('v1', 's1', { type: 'voice' })])]);
    expect(useSpaceStore.getState().voiceChannelIds.has('v1')).toBe(true);

    useSpaceStore.getState().removeSpace('s1');

    const s = useSpaceStore.getState();
    expect(s.voiceChannelIds.has('v1')).toBe(false);
    expect(s.spaceChannelIndex.has('v1')).toBe(false);
  });

  it('removeInstanceSpaces forgets the voice channels of that instance', () => {
    useSpaceStore.getState().populateFromReady(NOVA, [space('s1', [channel('v1', 's1', { type: 'voice' })])]);

    useSpaceStore.getState().removeInstanceSpaces(NOVA);

    expect(useSpaceStore.getState().voiceChannelIds.has('v1')).toBe(false);
  });

  it('a DM operation keeps the space entries, and a space change keeps the DM entries', () => {
    useSpaceStore.getState().populateFromReady('', [space('s1', [channel('c1', 's1')])], [], [dm('d1')]);
    useSpaceStore.getState().populateFromReady(NOVA, [space('s2', [channel('c2', 's2')])], [], []);
    expect(useSpaceStore.getState().channelOriginMap.get('d1')).toBe('');

    useSpaceStore.getState().removeInstanceSpaces(NOVA);
    expect(useSpaceStore.getState().channelOriginMap.get('d1')).toBe('');
    expect(useSpaceStore.getState().channelOriginMap.has('c2')).toBe(false);

    useSpaceStore.getState().removeDmChannel('d1');
    const s = useSpaceStore.getState();
    expect(s.channelOriginMap.has('d1')).toBe(false);
    expect(s.channelOriginMap.get('c1')).toBe('');
    expect(s.channelToSpaceMap.get('c1')).toBe('s1');
  });

  it('removeChannel drops the channel everywhere and replaces every map', () => {
    useSpaceStore.getState().populateFromReady(NOVA, [space('s1', [channel('v1', 's1', { type: 'voice' }), channel('c1', 's1', { lastMessageId: 'm1' })])]);
    const before = useSpaceStore.getState();

    useSpaceStore.getState().removeChannel('c1');
    useSpaceStore.getState().removeChannel('v1');

    const after = useSpaceStore.getState();
    for (const key of ['spaceChannelIndex', 'channelToSpaceMap', 'channelOriginMap', 'voiceChannelIds', 'channelPermissions', 'channelLastMessageIds'] as const) {
      expect(after[key]).not.toBe(before[key]);
    }
    expect(after.spaceChannelIndex.size).toBe(0);
    expect(after.channelLastMessageIds.has('c1')).toBe(false);
    expect(after.voiceChannelIds.has('v1')).toBe(false);
  });

  it('deleteChannel removes the channel from the index once the server agreed', async () => {
    useSpaceStore.getState().populateFromReady('', [space('s1', [channel('c1', 's1')])]);
    vi.spyOn(api.channels, 'delete').mockResolvedValueOnce(undefined as never);

    await useSpaceStore.getState().deleteChannel('c1');

    expect(useSpaceStore.getState().channelOriginMap.has('c1')).toBe(false);
  });

  it('loadSpaceDetail replaces the space channel set: a channel the detail no longer lists leaves the index', async () => {
    useSpaceStore.getState().populateFromReady('', [space('s1', [channel('c1', 's1'), channel('gone', 's1')])]);
    useSpaceStore.setState({ spaces: [tagged('s1', '')] });
    vi.spyOn(api.spaces, 'get').mockResolvedValueOnce(space('s1', [channel('c1', 's1'), channel('c2', 's1', { type: 'voice' })]));

    await useSpaceStore.getState().loadSpaceDetail('s1');

    const s = useSpaceStore.getState();
    expect([...s.spaceChannelIndex.keys()].sort()).toEqual(['c1', 'c2']);
    expect(s.voiceChannelIds.has('c2')).toBe(true);
    expect(s.channelPermissions.has('gone')).toBe(false);
  });
});

describe('isDmChannel answers from data only', () => {
  it('an unknown channel is not a DM, whatever the URL says', () => {
    window.history.replaceState(null, '', '/channels/@me/c1');
    expect(isDmChannel('c1')).toBe(false);
    expect(getChannelKind('c1')).toBe('unknown');
  });

  it('with no DMs at all a space channel is still a space channel on the DM route', () => {
    useSpaceStore.getState().populateFromReady('', [space('s1', [channel('c1', 's1')])], [], []);
    window.history.replaceState(null, '', '/channels/@me/c1');
    expect(isDmChannel('c1')).toBe(false);
    expect(getChannelKind('c1')).toBe('space');
  });

  it('a listed DM is a DM', () => {
    useSpaceStore.getState().populateFromReady('', [], [], [dm('d1')]);
    expect(isDmChannel('d1')).toBe(true);
    expect(getChannelKind('d1')).toBe('dm');
  });

  it('useIsDmChannel is unknown until the listing arrives, then follows it', () => {
    const { result } = renderHook(() => useIsDmChannel('d1'));
    expect(result.current).toBeUndefined();

    act(() => { useSpaceStore.getState().populateFromReady('', [], [], [dm('d1')]); });
    expect(result.current).toBe(true);

    act(() => { useSpaceStore.getState().removeDmChannel('d1'); });
    expect(result.current).toBeUndefined();
  });

  it('useIsDmChannel says false for a known space channel', () => {
    const { result } = renderHook(() => useIsDmChannel('c1'));
    act(() => { useSpaceStore.getState().populateFromReady('', [space('s1', [channel('c1', 's1')])]); });
    expect(result.current).toBe(false);
  });
});
