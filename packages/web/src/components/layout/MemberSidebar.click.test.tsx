import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { MemberSidebar } from './MemberSidebar';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../../utils/permissions';

// A left click on a member opens that member's profile card, for every
// viewer. Moderators reach the role editor from the card ("Edit Roles"), so
// the click means the same thing for everyone.

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

function user(id: string, name: string): User {
  return {
    id, username: name.toLowerCase(), displayName: name, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null,
    replicatedInstances: [],
  };
}
function member(id: string, name: string, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: id, nickname: null, joinedAt: 1, user: user(id, name), roles };
}

function seed(space: TaggedSpace, members: MemberWithUser[], held: bigint): void {
  useSpaceStore.setState({
    spaces: [space],
    currentSpaceId: SPACE_ID,
    loadingSpaceId: null,
    roles: [EVERYONE, LEADS, HELPERS],
    members,
    spacePermissions: new Map([[SPACE_ID, permissionsToString(held)]]),
  });
}

beforeEach(() => {
  useAuthStore.setState({ user: user('lead', 'Lena') });
  useUIStore.setState({
    isMobile: false,
    memberListOpen: true,
    activeModal: null,
    modalData: {},
    userProfilePopout: { user: null, anchor: null, placement: 'right', member: null },
  });
});

async function clickMember(name: string): Promise<void> {
  render(<MemoryRouter><MemberSidebar /></MemoryRouter>);
  await userEvent.click(screen.getByText(name));
}

describe('MemberSidebar: a click on a member', () => {
  it('opens the profile card for a moderator clicking a member they may edit', async () => {
    seed(SPACE, [member('owner', 'Olga', []), member('lead', 'Lena', [LEADS]), member('helper', 'Hugo', [HELPERS])], PermissionBits.MANAGE_ROLES);
    await clickMember('Hugo');

    expect(useUIStore.getState().activeModal).toBeNull();
    const popout = useUIStore.getState().userProfilePopout;
    expect(popout.user?.id).toBe('helper');
    expect(popout.member).toEqual({ spaceId: SPACE_ID, userId: 'helper' });
  });

  it('opens the profile card for the owner clicking anyone', async () => {
    useAuthStore.setState({ user: user('owner', 'Olga') });
    seed(SPACE, [member('owner', 'Olga', []), member('lead', 'Lena', [LEADS])], ALL_PERMISSIONS);
    await clickMember('Lena');

    expect(useUIStore.getState().activeModal).toBeNull();
    expect(useUIStore.getState().userProfilePopout.user?.id).toBe('lead');
  });

  it('opens the viewer\'s own card on a remote space, where they have a replicated id', async () => {
    seed(
      { ...SPACE, _instanceOrigin: ORBIT },
      [member('owner', 'Olga', []), member('lead-local', 'Lena', [LEADS]), member('helper', 'Hugo', [HELPERS])],
      PermissionBits.MANAGE_ROLES,
    );
    useAuthStore.getState().recordMyRow(ORBIT, 'lead-local');
    await clickMember('Lena');

    expect(useUIStore.getState().activeModal).toBeNull();
    expect(useUIStore.getState().userProfilePopout.member).toEqual({ spaceId: SPACE_ID, userId: 'lead-local' });
  });
});
