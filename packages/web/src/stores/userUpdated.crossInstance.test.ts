import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DmChannel, MemberWithUser, MessageWithUser, User } from '@backspace/shared';

vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
  wsSendAll: vi.fn(),
}));

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { useSpaceStore, type TaggedSpace } from './spaceStore';
import { useSocialStore, type TaggedFriend } from './socialStore';
import { useChatStore } from './chatStore';
import { useDiscoverStore, type TaggedDiscoverUser } from './discoverStore';
import type { TaggedFriendRequest } from './socialStore';

/**
 * A `user_updated` row applies to the rows of the person it is about: the
 * issuing instance's row with its id, and other instances' rows of the same
 * person when it is their home's row (profile fields only). Never to a row
 * on another instance that only has the same id (#353).
 *
 * The page's instance is nova (''); orbit is connected. Nova's Dave and
 * orbit's Cleo both have row id u-1. Bob is native to orbit (b-1); nova
 * knows him as replicated row nb.
 */
const ORBIT = 'https://orbit.example';

function user(id: string, username: string, displayName: string, home: { homeInstance: string; homeUserId: string } | null = null): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null, bio: null,
    status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: home?.homeInstance ?? null, homeUserId: home?.homeUserId ?? null, replicatedInstances: [],
  };
}

const daveOnNova = user('u-1', 'dave', 'Dave');
const cleoOnOrbit = user('u-1', 'cleo', 'Cleo');
const bobOnOrbit = user('b-1', 'bob', 'Bob');
const bobOnNova = user('nb', 'bob@orbit.example', 'Bob', { homeInstance: 'orbit.example', homeUserId: 'b-1' });

const cleoRenamed = { ...cleoOnOrbit, displayName: 'Cleo Renamed', avatar: 'https://orbit.example/api/uploads/cleo.png' };
const bobRenamed = { ...bobOnOrbit, displayName: 'Robert' };

function member(spaceId: string, row: User): MemberWithUser {
  return { spaceId, userId: row.id, nickname: null, joinedAt: 1, user: row, roles: [] };
}

function message(id: string, channelId: string, row: User): MessageWithUser {
  return {
    id, channelId, userId: row.id, replyToId: null, content: id, editedAt: null, createdAt: 1,
    user: row, attachments: [], embeds: [], reactions: [],
  };
}

function friend(row: User, origin: string): TaggedFriend {
  return { ...row, addedAt: 1, _instanceOrigin: origin } as TaggedFriend;
}

describe('updateUserEverywhere', () => {
  beforeEach(() => {
    useSpaceStore.getState().reset();
    useSpaceStore.setState({
      spaces: [{ id: 's-nova', _instanceOrigin: '' }, { id: 's-orbit', _instanceOrigin: ORBIT }] as TaggedSpace[],
      members: [member('s-nova', daveOnNova), member('s-nova', bobOnNova), member('s-orbit', cleoOnOrbit), member('s-orbit', bobOnOrbit)],
    });
  });

  function rosterRow(spaceId: string, userId: string): User {
    return useSpaceStore.getState().members.find(m => m.spaceId === spaceId && m.userId === userId)!.user;
  }

  it("leaves another instance's row that only has the same id alone", () => {
    useSpaceStore.getState().updateUserEverywhere(cleoRenamed, ORBIT);
    expect(rosterRow('s-orbit', 'u-1').displayName).toBe('Cleo Renamed');
    expect(rosterRow('s-nova', 'u-1')).toEqual(daveOnNova);
  });

  it("gives another instance's row of the same person the home's profile, keeping its id", () => {
    useSpaceStore.getState().updateUserEverywhere(bobRenamed, ORBIT);
    const copy = rosterRow('s-nova', 'nb');
    expect(copy.displayName).toBe('Robert');
    expect(copy.id).toBe('nb');
    expect(copy.homeUserId).toBe('b-1');
    expect(copy.username).toBe('bob@orbit.example');
  });

  it("never lets a replicated row's update overwrite the home's row", () => {
    useSpaceStore.getState().updateUserEverywhere({ ...bobOnNova, displayName: 'Stale' }, '');
    expect(rosterRow('s-nova', 'nb').displayName).toBe('Stale');
    expect(rosterRow('s-orbit', 'b-1').displayName).toBe('Bob');
  });

  it('patches DM members only on the copy the issuing instance holds', () => {
    useSpaceStore.getState().populateFromReady('', [], [], [{
      id: 'd-nova', federatedId: null, ownerId: null, createdAt: 0, members: [daveOnNova],
    } as unknown as DmChannel]);
    useSpaceStore.getState().populateFromReady(ORBIT, [], [], [{
      id: 'd-orbit', federatedId: null, ownerId: null, createdAt: 0, members: [cleoOnOrbit],
    } as unknown as DmChannel]);
    useSpaceStore.getState().updateUserEverywhere(cleoRenamed, ORBIT);
    const dms = useSpaceStore.getState().dmChannels;
    expect(dms.find(d => d.id === 'd-orbit')!.members[0]!.displayName).toBe('Cleo Renamed');
    expect(dms.find(d => d.id === 'd-nova')!.members[0]).toEqual(daveOnNova);
  });
});

describe('updateFriendProfile', () => {
  it("updates the friend the row is about, not a friend on another instance with the same id", () => {
    useSocialStore.setState({ friends: [friend(daveOnNova, ''), friend(cleoOnOrbit, ORBIT)] });
    useSocialStore.getState().updateFriendProfile(cleoRenamed, ORBIT);
    const [dave, cleo] = useSocialStore.getState().friends;
    expect(dave!.displayName).toBe('Dave');
    expect(cleo!.displayName).toBe('Cleo Renamed');
  });

  it("updates nova's friend row of an orbit native from orbit's row", () => {
    useSocialStore.setState({ friends: [friend(bobOnNova, '')] });
    useSocialStore.getState().updateFriendProfile(bobRenamed, ORBIT);
    expect(useSocialStore.getState().friends[0]!.displayName).toBe('Robert');
    expect(useSocialStore.getState().friends[0]!.id).toBe('nb');
  });
});

describe('updateUserInMessages', () => {
  beforeEach(() => {
    useSpaceStore.setState({ channelOriginMap: new Map([['c-nova', ''], ['c-orbit', ORBIT]]) });
    useChatStore.setState({
      messages: new Map([
        ['c-nova', [message('m1', 'c-nova', daveOnNova), message('m2', 'c-nova', bobOnNova)]],
        ['c-orbit', [message('m3', 'c-orbit', cleoOnOrbit)]],
      ]),
    });
  });

  function author(channelId: string, id: string): User {
    return useChatStore.getState().messages.get(channelId)!.find(m => m.id === id)!.user;
  }

  it("updates the authors the row is about, not another instance's author with the same id", () => {
    useChatStore.getState().updateUserInMessages(cleoRenamed, ORBIT);
    expect(author('c-orbit', 'm3').displayName).toBe('Cleo Renamed');
    expect(author('c-nova', 'm1')).toEqual(daveOnNova);
  });

  it("does not copy the issuing instance's row id into another instance's message", () => {
    useChatStore.getState().updateUserInMessages(bobRenamed, ORBIT);
    expect(author('c-nova', 'm2').displayName).toBe('Robert');
    expect(author('c-nova', 'm2').id).toBe('nb');
  });
});

describe('cleanup after a deletion', () => {
  const cleoDeleted = { ...cleoOnOrbit, isDeleted: true };
  const bobDeletedAtHome = { ...bobOnOrbit, isDeleted: true };
  const bobCopyDeletedOnNova = { ...bobOnNova, isDeleted: true };
  const jan = user('me-nova', 'jan', 'Jan');
  const janOnOrbit = user('me-orbit', 'jan@nova.example', 'Jan', { homeInstance: 'nova.example', homeUserId: 'me-nova' });

  /** A stored row named by its issuing instance and its id there. */
  function rowAt(row: { id: string; _instanceOrigin: string }): string {
    return `${row._instanceOrigin === ORBIT ? 'orbit' : 'nova'} ${row.id}`;
  }

  function request(id: string, origin: string, me: User, other: User): TaggedFriendRequest {
    return { id, fromId: other.id, toId: me.id, status: 'pending', createdAt: 1, user: other, _instanceOrigin: origin };
  }

  function card(row: User, origin: string): TaggedDiscoverUser {
    return {
      id: row.id, username: row.username, displayName: row.displayName, avatar: null, banner: null, avatarColor: null,
      bio: null, status: 'online', customStatus: null, createdAt: 1, homeInstance: row.homeInstance, homeUserId: row.homeUserId,
      mutualFriendCount: 0, mutualSpaceCount: 0, relationship: 'none', _instanceOrigin: origin,
    } as TaggedDiscoverUser;
  }

  beforeEach(() => {
    useSocialStore.setState({
      friends: [friend(daveOnNova, ''), friend(cleoOnOrbit, ORBIT), friend(bobOnNova, '')],
      requests: [request('r-nova', '', jan, daveOnNova), request('r-orbit', ORBIT, janOnOrbit, cleoOnOrbit), request('r-bob', '', jan, bobOnNova)],
    });
    useDiscoverStore.setState({
      users: [card(daveOnNova, ''), card(cleoOnOrbit, ORBIT), card(bobOnNova, '')],
      total: 3,
    });
    useSpaceStore.setState({ channelOriginMap: new Map([['c-nova', ''], ['c-orbit', ORBIT]]) });
    useChatStore.setState({
      typingUsers: new Map([
        ['c-nova', [{ userId: 'u-1', username: 'dave', timestamp: 1 }]],
        ['c-orbit', [{ userId: 'u-1', username: 'cleo', timestamp: 1 }]],
      ]),
    });
  });

  it("drops what is stored about the deleted user, not about another instance's user with the same id", () => {
    useSocialStore.getState().removeDeletedUser(cleoDeleted, ORBIT);
    useDiscoverStore.getState().removeDeletedUser(cleoDeleted, ORBIT);
    useChatStore.getState().clearTypingForDeletedUser(cleoDeleted, ORBIT);

    expect(useSocialStore.getState().friends.map(rowAt)).toEqual(['nova u-1', 'nova nb']);
    expect(useSocialStore.getState().requests.map(r => r.id)).toEqual(['r-nova', 'r-bob']);
    expect(useDiscoverStore.getState().users.map(rowAt)).toEqual(['nova u-1', 'nova nb']);
    expect(useDiscoverStore.getState().total).toBe(2);
    expect(useChatStore.getState().typingUsers.get('c-nova')).toEqual([{ userId: 'u-1', username: 'dave', timestamp: 1 }]);
    expect(useChatStore.getState().typingUsers.get('c-orbit')).toEqual([]);
  });

  it("drops another instance's rows of the person when their home deletes them", () => {
    useSocialStore.getState().removeDeletedUser(bobDeletedAtHome, ORBIT);
    useDiscoverStore.getState().removeDeletedUser(bobDeletedAtHome, ORBIT);

    expect(useSocialStore.getState().friends.map(rowAt)).toEqual(['nova u-1', 'orbit u-1']);
    expect(useSocialStore.getState().requests.map(r => r.id)).toEqual(['r-nova', 'r-orbit']);
    expect(useDiscoverStore.getState().users.map(rowAt)).toEqual(['nova u-1', 'orbit u-1']);
  });

  it("keeps the home's rows of the person when only another instance's copy is deleted", () => {
    useSocialStore.setState({ friends: [friend(bobOnOrbit, ORBIT), friend(bobOnNova, '')] });
    useSocialStore.getState().removeDeletedUser(bobCopyDeletedOnNova, '');

    expect(useSocialStore.getState().friends.map(rowAt)).toEqual(['orbit b-1']);
  });
});
