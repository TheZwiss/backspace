import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Channel, MemberWithUser, Role, SpaceWithChannelsAndMembers, User } from '@backspace/shared';

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

function detail(
  members: MemberWithUser[],
  extra: Partial<Pick<SpaceWithChannelsAndMembers, 'roles' | 'channels' | 'myPermissions'>> = {},
): SpaceWithChannelsAndMembers {
  return {
    id: SPACE.id, name: SPACE.name, icon: SPACE.icon, banner: SPACE.banner, avatarColor: SPACE.avatarColor,
    ownerId: SPACE.ownerId, inviteCode: SPACE.inviteCode, visibility: SPACE.visibility,
    directoryListed: SPACE.directoryListed, description: SPACE.description, createdAt: SPACE.createdAt,
    channels: [], categories: [], members, roles: [], ...extra,
  };
}

interface PendingLoad {
  done: Promise<Channel[] | undefined>;
  land: (d: SpaceWithChannelsAndMembers) => Promise<Channel[] | undefined>;
  fail: () => Promise<Channel[] | undefined>;
}

/** Starts a load whose fetch resolves only when the returned `land` (or `fail`) is called. */
function startLoad(options?: { quiet?: boolean }): PendingLoad {
  let resolve!: (d: SpaceWithChannelsAndMembers) => void;
  let reject!: (err: unknown) => void;
  vi.spyOn(api.spaces, 'get').mockReturnValueOnce(new Promise((res, rej) => { resolve = res; reject = rej; }));
  const done = useSpaceStore.getState().loadSpaceDetail(SPACE_ID, options);
  return {
    done,
    land: async (d) => {
      resolve(d);
      return done;
    },
    fail: async () => {
      reject(new Error('offline'));
      return done;
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

// One user action can start several loads of one space: a role change sends
// space_access_changed per write, and the settings panels reload after their
// own writes. Responses can land in any order. Only the newest request for a
// space may land; an older response arriving later would put back roles,
// positions and permissions the newer one replaced.

function role(id: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name: id, color: '#c4b5fd', position, permissions: '0', createdAt: 1 };
}
function channel(id: string): Channel & { myPermissions: string } {
  return { id, spaceId: SPACE_ID, name: id, type: 'text', topic: null, position: 0, categoryId: null, createdAt: 1, myPermissions: '1024' };
}
function rankedRoleIds(): string[] {
  return useSpaceStore.getState().roles.map((r) => r.id);
}

describe('loadSpaceDetail when loads of one space overlap', () => {
  // The owner moves Admins down twice. The first move's refresh answers with
  // Admins second; the second move's with Admins third.
  const AFTER_FIRST = detail([member('u-owner')], {
    roles: [role('r-mod', 3), role('r-admin', 2), role('r-guest', 1)],
    myPermissions: '1',
    channels: [channel('c-first')],
  });
  const AFTER_SECOND = detail([member('u-owner')], {
    roles: [role('r-mod', 3), role('r-guest', 2), role('r-admin', 1)],
    myPermissions: '2',
    channels: [channel('c-second')],
  });

  it('drops an older response that lands after a newer one', async () => {
    const first = startLoad({ quiet: true });
    const second = startLoad({ quiet: true });

    await second.land(AFTER_SECOND);
    expect(rankedRoleIds()).toEqual(['r-mod', 'r-guest', 'r-admin']);

    await first.land(AFTER_FIRST);
    expect(rankedRoleIds()).toEqual(['r-mod', 'r-guest', 'r-admin']);
    expect(useSpaceStore.getState().spacePermissions.get(SPACE_ID)).toBe('2');
    expect(useSpaceStore.getState().channels.map((c) => c.id)).toEqual(['c-second']);
  });

  it('resolves an overtaken load to what the newest one resolves to', async () => {
    const first = startLoad({ quiet: true });
    const second = startLoad({ quiet: true });

    const firstLanded = first.land(AFTER_FIRST);
    await second.land(AFTER_SECOND);
    const channels = await firstLanded;
    // A caller that reconciles channels from the result works on the newest list.
    expect(channels?.map((c) => c.id)).toEqual(['c-second']);
  });

  it('drops an older response that lands first too: it waits for the newest', async () => {
    const first = startLoad({ quiet: true });
    const second = startLoad({ quiet: true });

    const firstLanded = first.land(AFTER_FIRST);
    await new Promise((r) => setTimeout(r, 0));
    // Its response was built before the newer request; it changes nothing.
    expect(rankedRoleIds()).toEqual([]);
    await second.land(AFTER_SECOND);
    await firstLanded;
    expect(rankedRoleIds()).toEqual(['r-mod', 'r-guest', 'r-admin']);
  });

  it('holds a plain load to the same rule, and the newest load ends the loading state', async () => {
    const opening = startLoad();
    expect(useSpaceStore.getState().loadingSpaceId).toBe(SPACE_ID);
    const refresh = startLoad({ quiet: true });

    await refresh.land(AFTER_SECOND);
    expect(useSpaceStore.getState().loadingSpaceId).toBeNull();

    await opening.land(AFTER_FIRST);
    expect(rankedRoleIds()).toEqual(['r-mod', 'r-guest', 'r-admin']);
    expect(useSpaceStore.getState().loadingSpaceId).toBeNull();
  });

  it('ends the loading state when the newest load fails', async () => {
    startLoad();
    const refresh = startLoad({ quiet: true });
    await refresh.fail();
    expect(useSpaceStore.getState().loadingSpaceId).toBeNull();
  });

  it('does not let an overtaken load that fails touch the newer one\'s state', async () => {
    const first = startLoad({ quiet: true });
    const second = startLoad({ quiet: true });
    await second.land(AFTER_SECOND);
    await first.fail();
    expect(rankedRoleIds()).toEqual(['r-mod', 'r-guest', 'r-admin']);
  });

  it('only updates the permissions of a space that is no longer open when its load lands', async () => {
    useSpaceStore.setState({ roles: [role('r-elsewhere', 1)] });
    const load = startLoad();
    useSpaceStore.getState().setCurrentSpace('space-2');

    await load.land(AFTER_FIRST);

    const state = useSpaceStore.getState();
    expect(state.currentSpaceId).toBe('space-2');
    expect(rankedRoleIds()).toEqual(['r-elsewhere']);
    expect(state.spacePermissions.get(SPACE_ID)).toBe('1');
    expect(state.channelPermissions.get('c-first')).toBe('1024');
  });
});
