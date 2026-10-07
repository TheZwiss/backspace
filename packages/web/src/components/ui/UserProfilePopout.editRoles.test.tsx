import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));
vi.mock('../../utils/mutuals', () => ({
  loadFederatedMutuals: vi.fn().mockResolvedValue({ mutualFriends: [], mutualSpaces: [] }),
}));

import { UserProfilePopout } from './UserProfilePopout';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../../utils/permissions';

// A left click on a member opens the profile card for everyone. A moderator
// who may change that member's roles gets an "Edit Roles" action on the card,
// which opens the member role editor. It is offered by the same rule the
// editor itself follows (permissions.md, "Role hierarchy").

const SPACE_ID = 'space-1';
const ORBIT = 'https://orbit.example';

const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

function role(id: string, name: string, position: number, permissions: bigint): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: permissionsToString(permissions), createdAt: 1 };
}
const EVERYONE = role(SPACE_ID, '@everyone', 0, PermissionBits.VIEW_CHANNEL);
const LEADS = role('r-lead', 'Leads', 2, PermissionBits.MANAGE_ROLES);
const HELPERS = role('r-helper', 'Helpers', 1, PermissionBits.KICK_MEMBERS);

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

const MEMBERS = [
  member('owner', []), member('lead', [LEADS]), member('peer', [LEADS]), member('helper', [HELPERS]), member('plain', []),
];

function seed(opts: { viewer?: string; held?: bigint; roles?: Role[]; space?: TaggedSpace; members?: MemberWithUser[] } = {}): void {
  const space = opts.space ?? SPACE;
  useAuthStore.setState({ user: user(opts.viewer ?? 'lead') });
  useSpaceStore.setState({
    spaces: [space],
    currentSpaceId: SPACE_ID,
    roles: opts.roles ?? [EVERYONE, LEADS, HELPERS],
    members: opts.members ?? MEMBERS,
    spacePermissions: new Map([[SPACE_ID, permissionsToString(opts.held ?? (PermissionBits.MANAGE_ROLES | PermissionBits.VIEW_CHANNEL))]]),
  });
}

const anchor = { top: 100, left: 100, right: 140, bottom: 140, width: 40, height: 40 };

function renderCard(userId: string, context: { spaceId: string; userId: string } | null = { spaceId: SPACE_ID, userId }, onClose = () => {}) {
  const shown = useSpaceStore.getState().members.find((m) => m.userId === userId)!.user;
  render(
    <MemoryRouter>
      <UserProfilePopout user={shown} member={context} onClose={onClose} anchor={anchor} />
    </MemoryRouter>,
  );
}

const editRoles = () => screen.queryByRole('button', { name: 'Edit Roles' });

beforeEach(() => {
  useUIStore.setState({ isMobile: false, activeModal: null, modalData: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UserProfilePopout: Edit Roles', () => {
  it('is offered for a member ranked below the viewer and opens the role editor for them', async () => {
    seed();
    const onClose = vi.fn();
    renderCard('helper', { spaceId: SPACE_ID, userId: 'helper' }, onClose);

    await userEvent.click(screen.getByRole('button', { name: 'Edit Roles' }));

    expect(onClose).toHaveBeenCalled();
    expect(useUIStore.getState().activeModal).toBe('memberRoles');
    expect(useUIStore.getState().modalData).toEqual({ spaceId: SPACE_ID, userId: 'helper' });
  });

  it('is offered for a member without roles', () => {
    seed();
    renderCard('plain');
    expect(editRoles()).not.toBeNull();
  });

  it('is not offered for the viewer', () => {
    seed();
    renderCard('lead');
    expect(editRoles()).toBeNull();
  });

  it('is not offered for the owner', () => {
    seed();
    renderCard('owner');
    expect(editRoles()).toBeNull();
  });

  it('is not offered for a member of the same rank', () => {
    seed();
    renderCard('peer');
    expect(editRoles()).toBeNull();
  });

  it('is not offered without MANAGE_ROLES', () => {
    seed({ held: PermissionBits.KICK_MEMBERS });
    renderCard('helper');
    expect(editRoles()).toBeNull();
  });

  it('is not offered in a space with only @everyone', () => {
    seed({ viewer: 'owner', held: ALL_PERMISSIONS, roles: [EVERYONE] });
    renderCard('plain');
    expect(editRoles()).toBeNull();
  });

  it('is offered to the owner for any other member', () => {
    seed({ viewer: 'owner', held: ALL_PERMISSIONS });
    renderCard('peer');
    expect(editRoles()).not.toBeNull();
  });

  it('is not offered when the card was not opened for a space member', () => {
    seed();
    renderCard('helper', null);
    expect(editRoles()).toBeNull();
  });

  it('is not offered when that space is not the one loaded', () => {
    seed();
    useSpaceStore.setState({ currentSpaceId: 'space-2' });
    renderCard('helper');
    expect(editRoles()).toBeNull();
  });

  it('is not offered on mobile, where the role editor has no layout', () => {
    seed();
    useUIStore.setState({ isMobile: true });
    renderCard('helper');
    expect(editRoles()).toBeNull();
  });

  it('knows the viewer by their id on a remote space, not their home id', () => {
    // Home id "lead"; on orbit the viewer is their replicated user "lead-local".
    seed({
      space: { ...SPACE, _instanceOrigin: ORBIT },
      members: [member('owner', []), member('lead-local', [LEADS]), member('helper', [HELPERS])],
    });
    useAuthStore.getState().recordMyRow(ORBIT, 'lead-local');

    renderCard('lead-local');
    expect(editRoles()).toBeNull();
  });

  it('is offered on a remote space for a member ranked below the viewer there', () => {
    seed({
      space: { ...SPACE, _instanceOrigin: ORBIT },
      members: [member('owner', []), member('lead-local', [LEADS]), member('helper', [HELPERS])],
    });
    useAuthStore.getState().recordMyRow(ORBIT, 'lead-local');

    renderCard('helper');
    expect(editRoles()).not.toBeNull();
  });
});
