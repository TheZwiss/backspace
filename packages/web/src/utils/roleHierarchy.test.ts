import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { myStandingIn, viewerCanActOn, viewerCanManageRoleAt, viewerCanEditMemberRoles } from './roleHierarchy';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { PermissionBits, permissionsToString, ALL_PERMISSIONS } from './permissions';
import { useAuthStore } from '../stores/authStore';

// The viewer's standing is unknown (null, the server decides) when the
// space's roles do not have distinct positions from 1 up: an instance from
// before the role hierarchy keeps every role at 0 and ranks nobody, so
// comparing positions there would lock out every moderator.

const SPACE_ID = 'space-1';
const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

function role(id: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name: id, color: '#c4b5fd', position, permissions: '0', createdAt: 1 };
}
function user(id: string): User {
  return {
    id, username: id, displayName: id, avatar: null, banner: null, accentColor: null, avatarColor: null, bio: null,
    status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null,
    replicatedInstances: [],
  };
}
function member(id: string, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: id, nickname: null, joinedAt: 1, user: user(id), roles };
}

function seed(positions: { mod: number; helper: number }): MemberWithUser[] {
  const mod = role('r-mod', positions.mod);
  const helper = role('r-helper', positions.helper);
  const members = [member('owner', []), member('me', [helper]), member('senior', [mod])];
  useAuthStore.setState({ user: user('me') });
  useSpaceStore.setState({ spaces: [SPACE], currentSpaceId: SPACE_ID, roles: [role(SPACE_ID, 0), mod, helper], members });
  return members;
}

beforeEach(() => {
  useSpaceStore.setState({ roles: [], members: [] });
});

describe('myStandingIn', () => {
  it('ranks the viewer when every role has its own position', () => {
    const members = seed({ mod: 2, helper: 1 });
    expect(myStandingIn(SPACE, members)).toEqual({ isOwner: false, isInstanceAdmin: false, topPosition: 1 });
    expect(viewerCanActOn(SPACE, members, members[2]!)).toBe(false);
    expect(viewerCanManageRoleAt(SPACE, members, 1)).toBe(false);
  });

  it('is unknown on an instance from before the hierarchy, where every role sits at 0', () => {
    const members = seed({ mod: 0, helper: 0 });
    expect(myStandingIn(SPACE, members)).toBeNull();
    expect(viewerCanActOn(SPACE, members, members[2]!)).toBe(true);
    expect(viewerCanManageRoleAt(SPACE, members, 0)).toBe(true);
  });

  it('is unknown when two roles tie, even with the store\'s role list not loaded', () => {
    const members = seed({ mod: 1, helper: 1 });
    useSpaceStore.setState({ roles: [] });
    expect(myStandingIn(SPACE, members)).toBeNull();
  });
});

// The member role editor is offered from the profile card only when the
// viewer could change something there: MANAGE_ROLES, a target that is neither
// the viewer (on the space's own instance) nor the owner and ranks below the
// viewer, and at least one role below the viewer's top role.
describe('viewerCanEditMemberRoles', () => {
  const MANAGE = permissionsToString(PermissionBits.MANAGE_ROLES);

  function fixture(): { members: MemberWithUser[]; roles: Role[] } {
    const lead = role('r-lead', 3);
    const helper = role('r-helper', 1);
    const members = [
      member('owner', []), member('me', [lead]), member('peer', [lead]), member('helper', [helper]), member('plain', []),
    ];
    const roles = [role(SPACE_ID, 0), lead, role('r-mid', 2), helper];
    useAuthStore.setState({ user: user('me') });
    useSpaceStore.setState({ spaces: [SPACE], currentSpaceId: SPACE_ID, roles, members });
    return { members, roles };
  }
  const byId = (members: MemberWithUser[], id: string) => members.find((m) => m.userId === id)!;

  it('offers members ranked below the viewer, with or without roles', () => {
    const { members, roles } = fixture();
    expect(viewerCanEditMemberRoles(SPACE, members, roles, MANAGE, byId(members, 'helper'))).toBe(true);
    expect(viewerCanEditMemberRoles(SPACE, members, roles, MANAGE, byId(members, 'plain'))).toBe(true);
  });

  it('never offers the viewer, the owner, or a member ranked at or above the viewer', () => {
    const { members, roles } = fixture();
    expect(viewerCanEditMemberRoles(SPACE, members, roles, MANAGE, byId(members, 'me'))).toBe(false);
    expect(viewerCanEditMemberRoles(SPACE, members, roles, MANAGE, byId(members, 'owner'))).toBe(false);
    expect(viewerCanEditMemberRoles(SPACE, members, roles, MANAGE, byId(members, 'peer'))).toBe(false);
  });

  it('needs MANAGE_ROLES, known or not', () => {
    const { members, roles } = fixture();
    const helper = byId(members, 'helper');
    expect(viewerCanEditMemberRoles(SPACE, members, roles, permissionsToString(PermissionBits.KICK_MEMBERS), helper)).toBe(false);
    expect(viewerCanEditMemberRoles(SPACE, members, roles, undefined, helper)).toBe(false);
    expect(viewerCanEditMemberRoles(SPACE, members, roles, permissionsToString(PermissionBits.ADMINISTRATOR), helper)).toBe(true);
  });

  it('is not offered when no role below the viewer exists to give or take', () => {
    const { members } = fixture();
    useAuthStore.setState({ user: user('owner') });
    const onlyEveryone = [role(SPACE_ID, 0)];
    expect(viewerCanEditMemberRoles(SPACE, members, onlyEveryone, permissionsToString(ALL_PERMISSIONS), byId(members, 'plain'))).toBe(false);
  });

  it('knows the viewer by their id on the space\'s instance, not their home id', () => {
    const orbit = 'https://orbit.example';
    const remote: TaggedSpace = { ...SPACE, _instanceOrigin: orbit };
    const lead = role('r-lead', 2);
    const helper = role('r-helper', 1);
    const members = [member('owner', []), member('me-local', [lead]), member('helper', [helper])];
    const roles = [role(SPACE_ID, 0), lead, helper];
    useAuthStore.setState({ user: user('me') });
    useSpaceStore.setState({ spaces: [remote], currentSpaceId: SPACE_ID, roles, members });
    useAuthStore.getState().recordMyRow(orbit, 'me-local');
    expect(viewerCanEditMemberRoles(remote, members, roles, MANAGE, members[1]!)).toBe(false);
    expect(viewerCanEditMemberRoles(remote, members, roles, MANAGE, members[2]!)).toBe(true);
  });
});
