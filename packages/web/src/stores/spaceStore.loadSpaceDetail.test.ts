import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MemberWithUser, Role, SpaceWithChannelsAndMembers, User } from '@backspace/shared';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { useSpaceStore, type TaggedSpace } from './spaceStore';
import { api } from '../api/client';

// A member join or leave that arrives over the socket while the space's detail
// is being fetched must survive the fetched roster replacing `members`.

const SPACE_ID = 'space-1';

const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender',
  ownerId: 'u-owner', inviteCode: null, visibility: 'public', directoryListed: false,
  description: '', createdAt: 1, _instanceOrigin: '',
};

function user(id: string): User {
  return {
    id, username: id, displayName: null, avatar: null, banner: null, accentColor: null,
    avatarColor: null, bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

function member(id: string, spaceId = SPACE_ID): MemberWithUser {
  return { spaceId, userId: id, nickname: null, joinedAt: 1, user: user(id), roles: [] };
}

function detail(members: MemberWithUser[]): SpaceWithChannelsAndMembers {
  return {
    id: SPACE.id, name: SPACE.name, icon: SPACE.icon, banner: SPACE.banner, avatarColor: SPACE.avatarColor,
    ownerId: SPACE.ownerId, inviteCode: SPACE.inviteCode, visibility: SPACE.visibility,
    directoryListed: SPACE.directoryListed, description: SPACE.description, createdAt: SPACE.createdAt,
    channels: [], categories: [], members, roles: [],
  };
}

/** Starts a load whose fetch resolves only when the returned `land` is called. */
function startLoad(): { done: Promise<void>; land: (d: SpaceWithChannelsAndMembers) => Promise<void> } {
  let resolve!: (d: SpaceWithChannelsAndMembers) => void;
  vi.spyOn(api.spaces, 'get').mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const done = useSpaceStore.getState().loadSpaceDetail(SPACE_ID);
  return {
    done,
    land: async (d) => {
      resolve(d);
      await done;
    },
  };
}

function memberIds(): string[] {
  return useSpaceStore.getState().members.map((m) => m.userId).sort();
}

beforeEach(() => {
  useSpaceStore.getState().reset();
  useSpaceStore.setState({ spaces: [SPACE], currentSpaceId: SPACE_ID, members: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadSpaceDetail and live roster changes during the fetch', () => {
  it('keeps a member who joined while the fetch was in flight', async () => {
    const load = startLoad();
    useSpaceStore.getState().addMember(SPACE_ID, member('u-new'));
    await load.land(detail([member('u-owner')]));
    expect(memberIds()).toEqual(['u-new', 'u-owner']);
  });

  it('drops a member who left while the fetch was in flight', async () => {
    const load = startLoad();
    useSpaceStore.getState().removeMember(SPACE_ID, 'u-mira');
    await load.land(detail([member('u-owner'), member('u-mira')]));
    expect(memberIds()).toEqual(['u-owner']);
  });

  it('applies a join and a later leave in the order they arrived', async () => {
    const load = startLoad();
    useSpaceStore.getState().addMember(SPACE_ID, member('u-brief'));
    useSpaceStore.getState().removeMember(SPACE_ID, 'u-brief');
    await load.land(detail([member('u-owner')]));
    expect(memberIds()).toEqual(['u-owner']);
  });

  it('does not duplicate a joiner the fetched roster already has', async () => {
    const load = startLoad();
    useSpaceStore.getState().addMember(SPACE_ID, member('u-new'));
    await load.land(detail([member('u-owner'), member('u-new')]));
    expect(memberIds()).toEqual(['u-new', 'u-owner']);
  });

  it('keeps the fetched row of a joiner the fetched roster already has', async () => {
    // The join event carries the member as they joined; the response can be
    // newer, e.g. with a role assigned while the fetch was in flight.
    const mods: Role = { id: 'r-mod', spaceId: SPACE_ID, name: 'Moderators', color: '#c4b5fd', position: 2, createdAt: 1 };
    const load = startLoad();
    useSpaceStore.getState().addMember(SPACE_ID, member('u-new'));
    await load.land(detail([member('u-owner'), { ...member('u-new'), roles: [mods] }]));
    const fetched = useSpaceStore.getState().members.find((m) => m.userId === 'u-new');
    expect(fetched?.roles.map((r) => r.id)).toEqual(['r-mod']);
  });

  it('ignores changes for another space', async () => {
    const load = startLoad();
    useSpaceStore.getState().addMember('space-2', member('u-elsewhere', 'space-2'));
    await load.land(detail([member('u-owner')]));
    expect(memberIds()).toEqual(['u-owner']);
  });

  it('does not replay changes from an earlier load into a later one', async () => {
    const first = startLoad();
    useSpaceStore.getState().addMember(SPACE_ID, member('u-gone'));
    await first.land(detail([member('u-owner')]));

    const second = startLoad();
    await second.land(detail([member('u-owner')]));
    expect(memberIds()).toEqual(['u-owner']);
  });
});
