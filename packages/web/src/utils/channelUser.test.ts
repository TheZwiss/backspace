import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MemberWithUser, Role, User } from '@backspace/shared';
// The store graph reaches the audio engine, which needs Web Audio at import.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { useAuthStore } from '../stores/authStore';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { clearMyUserIdCache, setMyUserIdForOrigin } from './crossStoreResolvers';
import {
  filterMentionCandidates,
  getChannelMentionCandidates,
  getSelfIdInChannel,
  isSelfInChannel,
  resolveChannelUser,
} from './channelUser';

function makeUser(id: string, username: string, displayName: string | null): User {
  return {
    id,
    username,
    displayName,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 1,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  };
}

function member(spaceId: string, user: User, roles: Role[] = []): MemberWithUser {
  return { spaceId, userId: user.id, nickname: null, joinedAt: 1, user, roles };
}

function role(id: string, color: string, position: number): Role {
  return { id, spaceId: 'space-1', name: id, color, position } as unknown as Role;
}

const ORBIT = 'https://orbit.example';
const me = makeUser('me', 'alice', 'Alice');
const meOnOrbit = makeUser('me-orbit', 'alice@home.example', 'Alice');
const kai = makeUser('kai', 'kai', 'Kai');
const kaiOnOrbit = makeUser('kai-orbit', 'kai', 'Kai');
const zed = makeUser('zed', 'zed', null);

const homeDm = { id: 'dm-home', federatedId: 'fed-1', ownerId: null, createdAt: 1, members: [me, kai], lastMessage: null } as unknown as DmChannel;
const orbitDm = { id: 'dm-orbit', ownerId: null, createdAt: 1, members: [meOnOrbit, kaiOnOrbit], lastMessage: null } as unknown as DmChannel;

afterEach(() => {
  useAuthStore.setState({ user: null });
  useSpaceStore.setState({
    dmChannels: [],
    dmAlternatives: new Map(),
    members: [],
    spaces: [],
    currentSpaceId: null,
    channelOriginMap: new Map(),
    channelToSpaceMap: new Map(),
    userViews: new Map(),
  });
  clearMyUserIdCache();
});

describe('resolveChannelUser', () => {
  it("finds a DM member in the DM's members, with no space roster loaded", () => {
    useSpaceStore.setState({ dmChannels: [homeDm], members: [] });
    const found = resolveChannelUser(homeDm.id, kai.id);
    expect(found?.user.displayName).toBe('Kai');
    expect(found?.member).toBeNull();
    expect(found?.nameColor).toBeNull();
  });

  it("treats another origin's id for a listed DM as that DM, never as a space channel", () => {
    useSpaceStore.setState({
      dmChannels: [homeDm],
      dmAlternatives: new Map([['fed-1', new Map([['', homeDm.id], [ORBIT, 'dm-alt']])]]),
      channelToSpaceMap: new Map([['dm-alt', 'space-1']]),
      members: [member('space-1', zed)],
    });
    expect(resolveChannelUser('dm-alt', zed.id)).toBeNull();
  });

  it("resolves nobody under another origin's id for a DM: its ids are that origin's and its members are not held", () => {
    // The listed entry's members carry the home's ids. An id written under
    // orbit's channel id is one of orbit's ids, so neither the home id nor
    // orbit's id can be read against that member list.
    useSpaceStore.setState({
      dmChannels: [homeDm],
      channelOriginMap: new Map([[homeDm.id, '']]),
      dmAlternatives: new Map([['fed-1', new Map([['', homeDm.id], [ORBIT, 'dm-alt']])]]),
    });
    expect(resolveChannelUser('dm-alt', kai.id)).toBeNull();
    expect(resolveChannelUser('dm-alt', kaiOnOrbit.id)).toBeNull();
  });

  it('never consults the space roster for a DM', () => {
    useSpaceStore.setState({ dmChannels: [orbitDm], members: [member('space-1', kai)] });
    expect(resolveChannelUser(orbitDm.id, kai.id)).toBeNull();
  });

  it("finds a space member only when the loaded roster is that channel's space", () => {
    useSpaceStore.setState({
      channelToSpaceMap: new Map([['chan-1', 'space-1'], ['chan-2', 'space-2']]),
      members: [member('space-1', kai)],
    });
    expect(resolveChannelUser('chan-1', kai.id)?.member?.spaceId).toBe('space-1');
    expect(resolveChannelUser('chan-2', kai.id)).toBeNull();
  });

  it('misses a channel it knows nothing about', () => {
    useSpaceStore.setState({ members: [member('space-1', kai)] });
    expect(resolveChannelUser('chan-unknown', kai.id)).toBeNull();
  });

  it('colours a space member by their highest role, and the owner rose without roles', () => {
    useSpaceStore.setState({
      channelToSpaceMap: new Map([['chan-1', 'space-1']]),
      spaces: [{ id: 'space-1', ownerId: zed.id, _instanceOrigin: '' } as unknown as TaggedSpace],
      members: [
        member('space-1', kai, [role('low', '#00ff00', 1), role('high', '#ff0000', 5)]),
        member('space-1', zed),
        member('space-1', me),
      ],
    });
    expect(resolveChannelUser('chan-1', kai.id)?.nameColor).toBe('#ff0000');
    expect(resolveChannelUser('chan-1', zed.id)?.nameColor).toBe('#fda4af');
    expect(resolveChannelUser('chan-1', me.id)?.nameColor).toBeNull();
  });

  it('returns the best-known view of the user from the userViews cache', () => {
    const stub = makeUser('stub', '1234567890123456789@friend.example', null);
    stub.homeUserId = '999';
    stub.homeInstance = 'friend.example';
    const home = { ...makeUser('999', 'quinn', 'Quinn'), homeUserId: '999', homeInstance: 'friend.example' };
    useSpaceStore.setState({ dmChannels: [{ ...homeDm, members: [me, stub] } as DmChannel] });
    useSpaceStore.getState().upsertUserView(home, 'https://friend.example');
    expect(resolveChannelUser(homeDm.id, stub.id)?.user.displayName).toBe('Quinn');
    // The id stays the channel origin's id, whatever view is shown.
    expect(resolveChannelUser(homeDm.id, stub.id)?.userId).toBe(stub.id);
  });
});

describe('getChannelMentionCandidates', () => {
  it("lists a DM's members except me, in the DM origin's id space", () => {
    useAuthStore.setState({ user: me });
    setMyUserIdForOrigin(ORBIT, meOnOrbit.id);
    useSpaceStore.setState({
      dmChannels: [orbitDm],
      channelOriginMap: new Map([[orbitDm.id, ORBIT]]),
      members: [member('space-9', zed)],
    });
    expect(getChannelMentionCandidates(orbitDm.id).map((c) => c.userId)).toEqual([kaiOnOrbit.id]);
  });

  it("lists the channel's space roster and nothing from another space", () => {
    useSpaceStore.setState({
      channelToSpaceMap: new Map([['chan-1', 'space-1']]),
      members: [member('space-1', kai), member('space-2', zed)],
    });
    expect(getChannelMentionCandidates('chan-1').map((c) => c.userId)).toEqual([kai.id]);
  });

  it("is empty under another origin's id for a DM, never the listed entry's home ids", () => {
    useAuthStore.setState({ user: me });
    setMyUserIdForOrigin(ORBIT, meOnOrbit.id);
    useSpaceStore.setState({
      dmChannels: [homeDm],
      channelOriginMap: new Map([[homeDm.id, '']]),
      dmAlternatives: new Map([['fed-1', new Map([['', homeDm.id], [ORBIT, 'dm-alt']])]]),
    });
    expect(getChannelMentionCandidates('dm-alt')).toEqual([]);
  });

  it('is empty for a space channel whose roster is not loaded', () => {
    useSpaceStore.setState({
      channelToSpaceMap: new Map([['chan-1', 'space-1']]),
      members: [member('space-2', zed)],
    });
    expect(getChannelMentionCandidates('chan-1')).toEqual([]);
  });
});

describe('filterMentionCandidates', () => {
  it('matches the display name or the username, case-insensitively, capped at the limit', () => {
    useSpaceStore.setState({
      channelToSpaceMap: new Map([['chan-1', 'space-1']]),
      members: [member('space-1', kai), member('space-1', zed), member('space-1', me)],
    });
    const all = getChannelMentionCandidates('chan-1');
    expect(filterMentionCandidates(all, 'KA').map((c) => c.userId)).toEqual([kai.id]);
    expect(filterMentionCandidates(all, 'ali').map((c) => c.userId)).toEqual([me.id]);
    expect(filterMentionCandidates(all, '', 2)).toHaveLength(2);
  });
});

describe('self in a channel', () => {
  it("is my id on the channel's origin: home id at home, the remote id on a remote DM", () => {
    useAuthStore.setState({ user: me });
    setMyUserIdForOrigin(ORBIT, meOnOrbit.id);
    useSpaceStore.setState({
      dmChannels: [homeDm, orbitDm],
      channelOriginMap: new Map([[homeDm.id, ''], [orbitDm.id, ORBIT]]),
    });
    expect(getSelfIdInChannel(homeDm.id)).toBe(me.id);
    expect(getSelfIdInChannel(orbitDm.id)).toBe(meOnOrbit.id);
    expect(isSelfInChannel(orbitDm.id, meOnOrbit.id)).toBe(true);
    expect(isSelfInChannel(orbitDm.id, me.id)).toBe(false);
  });

  it("uses the origin of the copy an alternate DM id belongs to", () => {
    useAuthStore.setState({ user: me });
    setMyUserIdForOrigin(ORBIT, meOnOrbit.id);
    useSpaceStore.setState({
      dmChannels: [{ ...orbitDm, federatedId: 'fed-2' } as DmChannel],
      channelOriginMap: new Map([[orbitDm.id, ORBIT]]),
      dmAlternatives: new Map([['fed-2', new Map([[ORBIT, orbitDm.id], ['', 'dm-alt-home']])]]),
    });
    expect(getSelfIdInChannel(orbitDm.id)).toBe(meOnOrbit.id);
    expect(getSelfIdInChannel('dm-alt-home')).toBe(me.id);
  });
});
