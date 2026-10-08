import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Friend, FriendRequest, User } from '@backspace/shared';

/**
 * The friends and requests lists hold one entry per person (`userKey`),
 * whichever instances listed them, and an event from one instance reaches
 * only the rows that instance issued (#353, #419).
 *
 * The page's instance is home (''); orbit is connected. Dave is native to
 * home and Cleo to orbit, and both have row id u-1. Bob is native to orbit
 * (b-1); home knows him as replicated row nb.
 */
const { ORBIT, homeApi, orbitApi } = vi.hoisted(() => {
  const socialApi = () => ({
    friends: vi.fn<() => Promise<Friend[]>>(),
    requests: vi.fn<() => Promise<FriendRequest[]>>(),
    removeFriend: vi.fn<(id: string) => Promise<{ success: boolean }>>(async () => ({ success: true })),
    updateRequest: vi.fn<(id: string, status: string) => Promise<{ success: boolean }>>(async () => ({ success: true })),
    cancelRequest: vi.fn<(id: string) => Promise<{ success: boolean }>>(async () => ({ success: true })),
  });
  return { ORBIT: 'https://orbit.example', homeApi: socialApi(), orbitApi: socialApi() };
});

vi.mock('../api/client', () => ({
  api: { social: homeApi },
}));

vi.mock('./instanceStore', () => ({
  useInstanceStore: {
    getState: () => ({ instances: [{ origin: ORBIT, status: 'connected', api: { social: orbitApi } }] }),
    subscribe: () => () => {},
  },
  waitForAutoConnect: async () => {},
}));

vi.mock('./spaceStore', () => ({
  useSpaceStore: { getState: () => ({ upsertUserView: () => {} }) },
}));

vi.mock('../utils/assetUrls', () => ({
  normalizeUserAssets: (u: unknown) => u,
}));

import { useSocialStore, type TaggedFriend, type TaggedFriendRequest } from './socialStore';

function user(id: string, username: string, home: { homeInstance: string; homeUserId: string } | null = null): User {
  return {
    id, username, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null, bio: null,
    status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: home?.homeInstance ?? null, homeUserId: home?.homeUserId ?? null, replicatedInstances: [],
  };
}

function friend(row: User): Friend {
  return { ...row, addedAt: 1 } as Friend;
}

function request(id: string, me: string, other: User): FriendRequest {
  return { id, fromId: other.id, toId: me, status: 'pending', createdAt: 1, user: other };
}

const daveOnHome = user('u-1', 'dave');
const cleoOnOrbit = user('u-1', 'cleo');
const bobOnOrbit = user('b-1', 'bob');
const bobOnHome = user('nb', 'bob@orbit.example', { homeInstance: 'orbit.example', homeUserId: 'b-1' });

/** A list entry named by the instance whose row it is shown by, that row's id and the person's username. */
function shown(entry: { id: string; _instanceOrigin: string; username?: string; user?: User }): string {
  const name = entry.username ?? entry.user?.username ?? '';
  return `${entry._instanceOrigin === ORBIT ? 'orbit' : 'home'} ${entry.id} ${name}`;
}

function friendNames(): string[] {
  return useSocialStore.getState().friends.map(shown);
}

function requestNames(): string[] {
  return useSocialStore.getState().requests.map(r => `${shown(r)}`);
}

function friends(): TaggedFriend[] {
  return useSocialStore.getState().friends;
}

function requests(): TaggedFriendRequest[] {
  return useSocialStore.getState().requests;
}

beforeEach(() => {
  vi.clearAllMocks();
  useSocialStore.getState().reset();
  homeApi.friends.mockResolvedValue([friend(daveOnHome), friend(bobOnHome)]);
  orbitApi.friends.mockResolvedValue([friend(cleoOnOrbit), friend(bobOnOrbit)]);
  homeApi.requests.mockResolvedValue([request('r-1', 'me-home', daveOnHome), request('r-bob-home', 'me-home', bobOnHome)]);
  orbitApi.requests.mockResolvedValue([request('r-1', 'me-orbit', cleoOnOrbit), request('r-bob-orbit', 'me-orbit', bobOnOrbit)]);
});

describe('loading friends and requests from several instances', () => {
  it('lists two people native to different instances with the same row id as two entries', async () => {
    await useSocialStore.getState().loadFriends();
    expect(friendNames()).toEqual(['home u-1 dave', 'orbit b-1 bob', 'orbit u-1 cleo']);
  });

  it("lists a person two instances list once, shown by their home's row", async () => {
    await useSocialStore.getState().loadFriends();
    const bob = friends().find(f => f.username === 'bob')!;
    expect(shown(bob)).toBe('orbit b-1 bob');
    expect(bob._rows?.map(shown)).toEqual(['home nb bob@orbit.example', 'orbit b-1 bob']);
  });

  it('lists requests the same way: one per other party, never merged by id alone', async () => {
    await useSocialStore.getState().loadRequests();
    expect(requestNames()).toEqual(['home r-1 dave', 'orbit r-bob-orbit bob', 'orbit r-1 cleo']);
  });
});

describe('friend_removed', () => {
  beforeEach(async () => {
    await useSocialStore.getState().loadFriends();
  });

  it("removes the friend the sending instance names, not another instance's user with the same id", () => {
    useSocialStore.getState().removeFriendLocally('u-1', ORBIT);
    expect(friendNames()).toEqual(['home u-1 dave', 'orbit b-1 bob']);

    useSocialStore.getState().removeFriendLocally('u-1', '');
    expect(friendNames()).toEqual(['orbit b-1 bob']);
  });

  it('removes a person two instances list when either instance removes its row', () => {
    useSocialStore.getState().removeFriendLocally('nb', '');
    expect(friendNames()).toEqual(['home u-1 dave', 'orbit u-1 cleo']);

    // The other instance's event that follows the relay finds nothing left.
    useSocialStore.getState().removeFriendLocally('b-1', ORBIT);
    expect(friendNames()).toEqual(['home u-1 dave', 'orbit u-1 cleo']);
  });

  it("removes the merged entry on its shown row's instance's event too", () => {
    useSocialStore.getState().removeFriendLocally('b-1', ORBIT);
    expect(friendNames()).toEqual(['home u-1 dave', 'orbit u-1 cleo']);
  });

  it('ignores an id the sending instance never listed', () => {
    useSocialStore.getState().removeFriendLocally('nb', ORBIT);
    expect(friendNames()).toEqual(['home u-1 dave', 'orbit b-1 bob', 'orbit u-1 cleo']);
  });
});

describe('request removal events', () => {
  beforeEach(async () => {
    await useSocialStore.getState().loadRequests();
  });

  it("removes the request the sending instance names, not another instance's request with the same ids", () => {
    useSocialStore.getState().removeRequestById('r-1', ORBIT, 'u-1');
    expect(requestNames()).toEqual(['home r-1 dave', 'orbit r-bob-orbit bob']);
  });

  it("matches the other party by the sending instance's row id when the request id differs", () => {
    useSocialStore.getState().removeRequestById('r-unknown', '', 'u-1');
    expect(requestNames()).toEqual(['orbit r-bob-orbit bob', 'orbit r-1 cleo']);
  });

  it("removes a person's request two instances hold when either instance removes its row", () => {
    useSocialStore.getState().removeRequestById('r-bob-home', '');
    expect(requestNames()).toEqual(['home r-1 dave', 'orbit r-1 cleo']);
  });

  it('joins a request row that arrives for a listed person to their entry, so its removal finds it', () => {
    useSocialStore.getState().reset();
    useSocialStore.getState().addIncomingRequest(request('r-bob-orbit', 'me-orbit', bobOnOrbit), ORBIT);
    useSocialStore.getState().addIncomingRequest(request('r-bob-home', 'me-home', bobOnHome), '');
    expect(requestNames()).toEqual(['orbit r-bob-orbit bob']);

    useSocialStore.getState().removeRequestById('r-bob-home', '', 'nb');
    expect(requests()).toEqual([]);
  });

  it('keeps a request from a different person with the same id on another instance when one is accepted', () => {
    useSocialStore.getState().addFriendFromAccepted(friend(cleoOnOrbit), 'r-1', ORBIT);
    expect(requestNames()).toEqual(['home r-1 dave', 'orbit r-bob-orbit bob']);
    expect(friendNames()).toEqual(['orbit u-1 cleo']);
  });
});

describe('actions on a merged entry', () => {
  beforeEach(async () => {
    await useSocialStore.getState().loadFriends();
    await useSocialStore.getState().loadRequests();
  });

  it("removes a friend named by another instance's row of them on the instance the entry is shown by", async () => {
    // A group DM member row from home's copy of the DM.
    await useSocialStore.getState().removeFriend(bobOnHome, '');
    expect(orbitApi.removeFriend).toHaveBeenCalledWith('b-1');
    expect(homeApi.removeFriend).not.toHaveBeenCalled();
    expect(friendNames()).toEqual(['home u-1 dave', 'orbit u-1 cleo']);
  });

  it('removes the friend a row names, not a friend on another instance with the same id', async () => {
    await useSocialStore.getState().removeFriend(cleoOnOrbit, ORBIT);
    expect(orbitApi.removeFriend).toHaveBeenCalledWith('u-1');
    expect(homeApi.removeFriend).not.toHaveBeenCalled();
    expect(friendNames()).toEqual(['home u-1 dave', 'orbit b-1 bob']);
  });

  it('sends an accept to the instance that holds the request and drops only that person', async () => {
    await useSocialStore.getState().updateFriendRequest('r-1', ORBIT, 'accepted');
    expect(orbitApi.updateRequest).toHaveBeenCalledWith('r-1', 'accepted');
    expect(homeApi.updateRequest).not.toHaveBeenCalled();
    expect(requestNames()).toEqual(['home r-1 dave', 'orbit r-bob-orbit bob']);
  });

  it("declines by another instance's row of a merged request and drops the whole entry", async () => {
    await useSocialStore.getState().updateFriendRequest('r-bob-home', '', 'declined');
    expect(homeApi.updateRequest).toHaveBeenCalledWith('r-bob-home', 'declined');
    expect(requestNames()).toEqual(['home r-1 dave', 'orbit r-1 cleo']);
  });

  it('cancels on the instance that holds the request', async () => {
    await useSocialStore.getState().cancelFriendRequest('r-1', '');
    expect(homeApi.cancelRequest).toHaveBeenCalledWith('r-1');
    expect(orbitApi.cancelRequest).not.toHaveBeenCalled();
    expect(requestNames()).toEqual(['orbit r-bob-orbit bob', 'orbit r-1 cleo']);
  });

  it("keeps the person when only another instance's copy of them is deleted, shown by the row left", () => {
    useSocialStore.getState().removeDeletedUser(bobOnHome, '');
    const bob = friends().find(f => f.username === 'bob')!;
    expect(shown(bob)).toBe('orbit b-1 bob');
    expect(bob._rows).toBeUndefined();
  });

  it("shows a person by another instance's row when the shown copy is deleted, with the status it was given", () => {
    // Erin is native to nova, which is not connected; home and orbit each hold a copy of her.
    const erinOnHome = user('e-h', 'erin@nova.example', { homeInstance: 'nova.example', homeUserId: 'e-1' });
    const erinOnOrbit = user('e-o', 'erin@nova.example', { homeInstance: 'nova.example', homeUserId: 'e-1' });
    useSocialStore.getState().addFriendFromAccepted(friend(erinOnHome), 'r-e-h', '');
    useSocialStore.getState().addFriendFromAccepted(friend(erinOnOrbit), 'r-e-o', ORBIT);
    expect(friends().filter(f => f.username.startsWith('erin')).map(shown)).toEqual(['home e-h erin@nova.example']);

    useSocialStore.getState().updateFriendPresence(erinOnOrbit, ORBIT, 'dnd');
    useSocialStore.getState().removeDeletedUser(erinOnHome, '');

    const erin = friends().filter(f => f.username.startsWith('erin'));
    expect(erin.map(shown)).toEqual(['orbit e-o erin@nova.example']);
    expect(erin[0]!.status).toBe('dnd');
  });
});
