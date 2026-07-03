import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

vi.mock('./instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ instances: [], _autoConnectDone: true }),
    {
      getState: () => ({ instances: [], _autoConnectDone: true }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    {
      getState: () => ({ user: null, token: null }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

import { useSpaceStore } from './spaceStore';
import type { Channel } from '@backspace/shared';

const SPACE = 'space-1';

function makeChannel(extras: Partial<Channel> & Pick<Channel, 'id'>): Channel {
  return {
    spaceId: SPACE,
    name: extras.id,
    type: 'text',
    topic: null,
    position: 0,
    categoryId: null,
    createdAt: 0,
    ...extras,
  };
}

beforeEach(() => {
  useSpaceStore.getState().reset();
  useSpaceStore.setState({ currentSpaceId: SPACE });
});

describe('upsertChannel', () => {
  it('adds a new channel to the open space with its permission entry', () => {
    const ch = makeChannel({ id: 'c1', position: 3, myPermissions: '1' });
    useSpaceStore.getState().upsertChannel(ch, SPACE, '');

    const s = useSpaceStore.getState();
    expect(s.channels.map(c => c.id)).toEqual(['c1']);
    expect(s.channelPermissions.get('c1')).toBe('1');
    expect(s.channelToSpaceMap.get('c1')).toBe(SPACE);
  });

  it('replaces channelPermissions with a FRESH reference (the re-render trigger)', () => {
    // This is the regression guard: an in-place Map mutation sets the value but
    // never changes identity, so the visibleChannels memo never recomputes.
    const before = useSpaceStore.getState().channelPermissions;
    useSpaceStore.getState().upsertChannel(makeChannel({ id: 'c1', myPermissions: '1' }), SPACE, '');
    const after = useSpaceStore.getState().channelPermissions;

    expect(after).not.toBe(before);
    expect(after.get('c1')).toBe('1');
  });

  it('reconciles a channel already added optimistically without a permission entry', () => {
    // Simulate the race: optimistic create inserted the channel into `channels`
    // but no permission was known yet, so it was filtered out of the sidebar.
    useSpaceStore.setState({ channels: [makeChannel({ id: 'c1' })] });
    expect(useSpaceStore.getState().channelPermissions.has('c1')).toBe(false);

    // The channel_created event (or the create response) arrives with perms.
    useSpaceStore.getState().upsertChannel(makeChannel({ id: 'c1', myPermissions: '1' }), SPACE, '');

    const s = useSpaceStore.getState();
    expect(s.channels.filter(c => c.id === 'c1')).toHaveLength(1); // no duplicate
    expect(s.channelPermissions.get('c1')).toBe('1');
  });

  it('keeps voice channels out of the channels list updates but tracks them globally', () => {
    useSpaceStore.getState().upsertChannel(makeChannel({ id: 'v1', type: 'voice', myPermissions: '1' }), SPACE, '');
    const s = useSpaceStore.getState();
    expect(s.voiceChannelIds.has('v1')).toBe(true);
    expect(s.channels.map(c => c.id)).toContain('v1');
  });

  it('updates lookup maps but not the channels list for a non-open space', () => {
    useSpaceStore.getState().upsertChannel(
      makeChannel({ id: 'c2', spaceId: 'space-2', myPermissions: '1' }),
      'space-2',
      '',
    );
    const s = useSpaceStore.getState();
    expect(s.channels.map(c => c.id)).not.toContain('c2'); // different space, list untouched
    expect(s.channelToSpaceMap.get('c2')).toBe('space-2');
    expect(s.channelPermissions.get('c2')).toBe('1'); // perms still tracked
  });
});
