import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel, MemberWithUser, User } from '@backspace/shared';
// The store graph reaches the audio engine, which needs Web Audio at import.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { useAuthStore } from '../stores/authStore';
import { useSpaceStore } from '../stores/spaceStore';
import { clearMyUserIdCache, setMyUserIdForOrigin } from './crossStoreResolvers';
import { useChannelMentionCandidates, useChannelUser, useSelfIdInChannel } from './channelUser';

function makeUser(id: string, username: string, displayName: string | null): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

function member(spaceId: string, user: User): MemberWithUser {
  return { spaceId, userId: user.id, nickname: null, joinedAt: 1, user, roles: [] };
}

function channel(id: string, spaceId: string): Channel {
  return { id, spaceId, name: id, type: 'text', topic: null, position: 0, categoryId: null, createdAt: 0 };
}

const ORBIT = 'https://orbit.example';
const me = makeUser('me', 'alice', 'Alice');
const meOnOrbit = makeUser('me-orbit', 'alice@home.example', 'Alice');
const kai = makeUser('kai', 'kai', 'Kai');

afterEach(() => {
  useAuthStore.setState({ user: null });
  useSpaceStore.getState().reset();
  clearMyUserIdCache();
});

// The channel lookup maps are updated in place by `upsertChannel` and several
// WS handlers; a hook must still see the new entry on the next store update.
describe('channelUser hooks and in-place lookup map updates', () => {
  it('resolves a member once a new channel of the loaded space is upserted', () => {
    useSpaceStore.setState({ currentSpaceId: 'space-1', members: [member('space-1', kai)] });
    const { result } = renderHook(() => useChannelUser('chan-new', kai.id));
    expect(result.current).toBeNull();

    act(() => useSpaceStore.getState().upsertChannel(channel('chan-new', 'space-1'), 'space-1', ''));

    expect(result.current?.userId).toBe(kai.id);
  });

  it("lists the new channel's space roster once the channel is upserted", () => {
    useSpaceStore.setState({ currentSpaceId: 'space-1', members: [member('space-1', kai)] });
    const { result } = renderHook(() => useChannelMentionCandidates('chan-new'));
    expect(result.current).toEqual([]);

    act(() => useSpaceStore.getState().upsertChannel(channel('chan-new', 'space-1'), 'space-1', ''));

    expect(result.current.map((c) => c.userId)).toEqual([kai.id]);
  });

  it("follows a channel's origin set in place", () => {
    useAuthStore.setState({ user: me });
    setMyUserIdForOrigin(ORBIT, meOnOrbit.id);
    useSpaceStore.setState({ currentSpaceId: 'space-9' });
    const { result } = renderHook(() => useSelfIdInChannel('chan-orbit'));
    expect(result.current).toBe(me.id);

    act(() => useSpaceStore.getState().upsertChannel(channel('chan-orbit', 'space-9'), 'space-9', ORBIT));

    expect(result.current).toBe(meOnOrbit.id);
  });
});
