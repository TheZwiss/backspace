import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Friend } from '@backspace/shared';

vi.mock('../stores/instanceStore', () => ({
  useInstanceStore: { getState: () => ({ instances: [] }), subscribe: () => () => {} },
  waitForAutoConnect: async () => {},
  getFriendsHomeOrigin: () => '',
}));

vi.mock('../stores/spaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ spaces: [], currentSpaceId: null, members: [], dmChannels: [], channelOriginMap: new Map(), upsertUserView: () => {} }),
  },
}));

vi.mock('../stores/activityStore', () => ({
  useActivityStore: { getState: () => ({ originRows: new Map() }) },
}));

import { useSocialStore } from '../stores/socialStore';
import { presenceSubjectOf } from './presenceSubject';

const ORBIT = 'https://orbit.example';

function friend(id: string, homeInstance: string | null, homeUserId: string): Friend {
  return {
    id, username: id, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null, bio: null,
    status: 'online', customStatus: null, isAdmin: false, createdAt: 1, addedAt: 1,
    homeInstance, homeUserId, replicatedInstances: [],
  } as Friend;
}

describe('presenceSubjectOf for a server that sends only its row id', () => {
  beforeEach(() => {
    useSocialStore.getState().reset();
    // Bob's entry is shown by orbit's native row; the page's instance holds a replicated row of him.
    useSocialStore.getState().addFriendFromAccepted(friend('b-1', null, 'b-1'), 'r-o', ORBIT);
    useSocialStore.getState().addFriendFromAccepted(friend('nb', 'orbit.example', 'b-1'), 'r-h', '');
  });

  it("names a friend by a row other than the one their entry is shown by", () => {
    expect(presenceSubjectOf({ userId: 'nb' }, '')).toMatchObject({ id: 'nb', homeInstance: 'orbit.example', homeUserId: 'b-1' });
  });

  it('takes an id the delivering instance never listed as native there', () => {
    expect(presenceSubjectOf({ userId: 'nb' }, ORBIT)).toEqual({ id: 'nb' });
  });
});
