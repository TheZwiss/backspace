import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Channel, MemberWithUser, Role, SpaceWithChannelsAndMembers, User } from '@backspace/shared';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { useSpaceStore } from './spaceStore';
import { api } from '../api/client';
import { PermissionBits, hasPermissionBit, permissionsToString } from '../utils/permissions';
import { viewerHeldPermissions } from '../utils/roleHierarchy';
import { memberNameColor } from '../utils/memberGroups';

// A server sends a role's permission bits only to members who hold
// MANAGE_ROLES (docs/systems/permissions.md, "Who receives role and override
// data"). Everyone else gets roles with display fields only. The client never
// computes its own permissions from roles: it reads the `myPermissions` the
// server computed for the space and for each channel. These tests feed the
// store payloads without role bits and check that everything the member sees
// still works.

const SPACE_ID = 'space-1';
const GENERAL: Channel = {
  id: 'ch-general', spaceId: SPACE_ID, name: 'general', type: 'text', topic: null, position: 0,
  categoryId: null, createdAt: 1,
  myPermissions: permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES),
};
const STAFF: Channel = {
  id: 'ch-staff', spaceId: SPACE_ID, name: 'staff', type: 'text', topic: null, position: 1,
  categoryId: null, isPrivate: true, createdAt: 1,
  // Granted by an override on the member's role, which the member never receives.
  myPermissions: permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.MANAGE_MESSAGES),
};
const SPACE_BITS = permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.ATTACH_FILES);

function user(id: string): User {
  return {
    id, username: id, displayName: null, avatar: null, banner: null, accentColor: null,
    avatarColor: null, bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

function role(id: string, position: number, color: string, permissions?: string): Role {
  const r: Role = { id, spaceId: SPACE_ID, name: id, color, position, isEveryone: id === SPACE_ID, createdAt: 1 };
  if (permissions !== undefined) r.permissions = permissions;
  return r;
}

const EVERYONE = role(SPACE_ID, 0, '#b9bbbe');
const VIP = role('r-vip', 1, '#0000ff');
const MODS = role('r-mod', 2, '#00ff00');

function member(id: string, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: id, nickname: null, joinedAt: 1, user: user(id), roles };
}

function space(roles: Role[], extra: Partial<SpaceWithChannelsAndMembers> = {}): SpaceWithChannelsAndMembers {
  return {
    id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender',
    ownerId: 'u-owner', inviteCode: null, visibility: 'public', directoryListed: false,
    description: null, createdAt: 1,
    channels: [GENERAL, STAFF], categories: [],
    members: [member('u-owner', []), member('u-me', [VIP]), member('u-mod', [MODS])],
    roles,
    myPermissions: SPACE_BITS,
    ...extra,
  };
}

beforeEach(() => {
  useSpaceStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a member who receives roles without bits', () => {
  it('reads the space and channel permissions from a ready payload without role bits', () => {
    useSpaceStore.getState().populateFromReady('', [space([EVERYONE, VIP, MODS])]);
    const state = useSpaceStore.getState();

    expect(state.spacePermissions.get(SPACE_ID)).toBe(SPACE_BITS);
    expect(hasPermissionBit(state.spacePermissions.get(SPACE_ID), PermissionBits.ATTACH_FILES)).toBe(true);
    expect(hasPermissionBit(state.spacePermissions.get(SPACE_ID), PermissionBits.MANAGE_ROLES)).toBe(false);
    expect(state.channelPermissions.get(GENERAL.id)).toBe(GENERAL.myPermissions);
    // The override on the member's role reaches them as the channel's computed bits.
    expect(hasPermissionBit(state.channelPermissions.get(STAFF.id), PermissionBits.MANAGE_MESSAGES)).toBe(true);
    expect(hasPermissionBit(state.channelPermissions.get(GENERAL.id), PermissionBits.MANAGE_MESSAGES)).toBe(false);
    expect(viewerHeldPermissions(state.spacePermissions, SPACE_ID)).toBe(PermissionBits.VIEW_CHANNEL | PermissionBits.ATTACH_FILES);
  });

  it('keeps the role list, the colours and the ranks from a detail without role bits', async () => {
    useSpaceStore.setState({
      spaces: [{ ...space([]), _instanceOrigin: '' }],
      currentSpaceId: SPACE_ID,
    });
    vi.spyOn(api.spaces, 'get').mockResolvedValueOnce(space([EVERYONE, VIP, MODS]));
    await useSpaceStore.getState().loadSpaceDetail(SPACE_ID);
    const state = useSpaceStore.getState();

    expect(state.roles.map(r => [r.id, r.color, r.position])).toEqual([
      ['r-mod', '#00ff00', 2], ['r-vip', '#0000ff', 1], [SPACE_ID, '#b9bbbe', 0],
    ]);
    for (const r of state.roles) expect(r.permissions).toBeUndefined();
    const me = state.members.find(m => m.userId === 'u-me');
    expect(me && memberNameColor(me, 'u-owner')).toBe('#0000ff');
    expect(state.spacePermissions.get(SPACE_ID)).toBe(SPACE_BITS);
    expect(state.channelPermissions.get(STAFF.id)).toBe(STAFF.myPermissions);
  });

  it('takes the bits from the refetch after they are given MANAGE_ROLES, and drops them after it is taken away', async () => {
    useSpaceStore.setState({
      spaces: [{ ...space([]), _instanceOrigin: '' }],
      currentSpaceId: SPACE_ID,
    });
    const managerBits = permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.MANAGE_ROLES);
    const withBits = [
      role(SPACE_ID, 0, '#b9bbbe', '1024'), role('r-vip', 1, '#0000ff', '4096'), role('r-mod', 2, '#00ff00', '8'),
    ];
    vi.spyOn(api.spaces, 'get')
      .mockResolvedValueOnce(space(withBits, { myPermissions: managerBits }))
      .mockResolvedValueOnce(space([EVERYONE, VIP, MODS]));

    await useSpaceStore.getState().loadSpaceDetail(SPACE_ID, { quiet: true });
    expect(useSpaceStore.getState().roles.map(r => r.permissions)).toEqual(['8', '4096', '1024']);
    expect(hasPermissionBit(useSpaceStore.getState().spacePermissions.get(SPACE_ID), PermissionBits.MANAGE_ROLES)).toBe(true);

    await useSpaceStore.getState().loadSpaceDetail(SPACE_ID, { quiet: true });
    for (const r of useSpaceStore.getState().roles) expect(r.permissions).toBeUndefined();
    expect(hasPermissionBit(useSpaceStore.getState().spacePermissions.get(SPACE_ID), PermissionBits.MANAGE_ROLES)).toBe(false);
  });
});
