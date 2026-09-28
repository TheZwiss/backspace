import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { MembersPanel } from './MembersPanel';
import { useSpaceStore, type TaggedSpace } from '../../../stores/spaceStore';
import { useAuthStore } from '../../../stores/authStore';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../../../utils/permissions';

// The member role editor in Space Settings > Members: a role can be given
// only when it ranks below the viewer and the viewer holds every bit it
// carries (permissions.md, "Role hierarchy" and "Held-bits rule"); each
// locked checkbox says why.

const SPACE_ID = 'space-1';
const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

const LEAD_BITS = PermissionBits.MANAGE_ROLES | PermissionBits.KICK_MEMBERS;

function role(id: string, name: string, position: number, permissions: bigint): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: permissionsToString(permissions), createdAt: 1 };
}
const EVERYONE = role(SPACE_ID, '@everyone', 0, PermissionBits.VIEW_CHANNEL);
const COUNCIL = role('r-council', 'Council', 4, LEAD_BITS);
const LEADS = role('r-lead', 'Leads', 3, LEAD_BITS);
const ADMINS = role('r-admin', 'Admins', 2, PermissionBits.ADMINISTRATOR);
const HELPERS = role('r-helper', 'Helpers', 1, PermissionBits.KICK_MEMBERS);

function user(id: string): User {
  return {
    id, username: id, displayName: id.charAt(0).toUpperCase() + id.slice(1), avatar: null, banner: null,
    accentColor: null, avatarColor: null, bio: null, status: 'online', customStatus: null, isAdmin: false,
    createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}
function member(id: string, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: id, nickname: null, joinedAt: 1, user: user(id), roles };
}

beforeEach(() => {
  useAuthStore.setState({ user: user('lead') });
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    roles: [EVERYONE, COUNCIL, LEADS, ADMINS, HELPERS],
    members: [
      member('owner', []),
      member('lead', [LEADS]),
      member('alt', []),
      member('senior', [ADMINS]),
    ],
    spacePermissions: new Map([[SPACE_ID, permissionsToString(LEAD_BITS | PermissionBits.VIEW_CHANNEL)]]),
  });
});

describe('the member role editor', () => {
  it('locks a lower role that carries a bit the viewer does not hold, and says why', async () => {
    render(<MembersPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByText('Alt'));

    expect(screen.getByRole('checkbox', { name: 'Helpers' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Admins' })).toBeDisabled();
    expect(screen.getByText('Roles with permissions you do not have cannot be given.')).toBeInTheDocument();
  });

  it('locks roles at or above the viewer\'s own, and says why', async () => {
    render(<MembersPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByText('Alt'));

    expect(screen.getByRole('checkbox', { name: 'Leads' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Council' })).toBeDisabled();
    expect(screen.getByText('Roles at or above your highest role are locked.')).toBeInTheDocument();
  });

  it('lets the viewer take such a role from a member ranked below them', async () => {
    render(<MembersPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByText('Senior'));

    const admins = screen.getByRole('checkbox', { name: 'Admins' });
    expect(admins).toBeEnabled();
    await userEvent.click(admins);
    expect(admins).not.toBeChecked();
  });

  it('locks nothing for bits when the viewer holds every permission', async () => {
    useSpaceStore.setState({ spacePermissions: new Map([[SPACE_ID, permissionsToString(ALL_PERMISSIONS)]]) });
    render(<MembersPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByText('Alt'));
    expect(screen.getByRole('checkbox', { name: 'Admins' })).toBeEnabled();
    expect(screen.queryByText('Roles with permissions you do not have cannot be given.')).toBeNull();
  });
});
