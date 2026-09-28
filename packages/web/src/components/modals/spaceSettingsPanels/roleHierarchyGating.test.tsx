import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { MembersPanel } from './MembersPanel';
import { RolesPanel } from './RolesPanel';
import { useSpaceStore, type TaggedSpace } from '../../../stores/spaceStore';
import { useAuthStore } from '../../../stores/authStore';
import { PermissionBits, permissionsToString } from '../../../utils/permissions';

// #299: settings do not offer what the server refuses under the role
// hierarchy (permissions.md, "Role hierarchy" and "Client gating").

const SPACE_ID = 'space-1';
const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

const MODERATION = permissionsToString(PermissionBits.KICK_MEMBERS | PermissionBits.BAN_MEMBERS | PermissionBits.MANAGE_ROLES);

function role(id: string, name: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: MODERATION, createdAt: 1 };
}
const EVERYONE = role(SPACE_ID, '@everyone', 0);
const MODS = role('r-mod', 'Moderators', 3);
const HELPERS = role('r-helper', 'Helpers', 2);
const MEMBERS_ROLE = role('r-member', 'Members', 1);

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
  useAuthStore.setState({ user: user('helper') });
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    roles: [EVERYONE, MODS, HELPERS, MEMBERS_ROLE],
    members: [
      member('owner', []),
      member('helper', [HELPERS]),
      member('senior', [MODS]),
      member('junior', [MEMBERS_ROLE]),
    ],
    spacePermissions: new Map([[SPACE_ID, MODERATION]]),
  });
});

function rowOf(name: string): HTMLElement {
  const label = screen.getByText(name);
  const row = label.closest('.justify-between');
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  return row;
}

describe('MembersPanel', () => {
  it('offers kick and ban only against members ranked below the viewer', () => {
    render(<MembersPanel spaceId={SPACE_ID} />);
    expect(within(rowOf('Senior')).queryByRole('button', { name: 'Kick' })).toBeNull();
    expect(within(rowOf('Senior')).queryByRole('button', { name: 'Ban' })).toBeNull();
    expect(within(rowOf('Junior')).getByRole('button', { name: 'Kick' })).toBeInTheDocument();
    expect(within(rowOf('Junior')).getByRole('button', { name: 'Ban' })).toBeInTheDocument();
  });

  it('lets the viewer hand out only roles below their own top role', async () => {
    render(<MembersPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByText('Junior'));
    expect(screen.getByRole('checkbox', { name: 'Members' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Helpers' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Moderators' })).toBeDisabled();
  });
});

describe('RolesPanel', () => {
  it('shows a role at or above the viewer\'s top role read-only, without Delete', async () => {
    render(<RolesPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Moderators' }));
    const note = screen.getByText(/ranks at or above your highest role/);
    // Styled like the held-bits note: the same padlock in front.
    expect(note.parentElement?.querySelector('svg path')).not.toBeNull();
    expect(screen.getByDisplayValue('Moderators')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Delete Role' })).toBeNull();
  });

  it('keeps a role below the viewer\'s top role editable', async () => {
    render(<RolesPanel spaceId={SPACE_ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Members' }));
    expect(screen.queryByText(/ranks at or above your highest role/)).toBeNull();
    expect(screen.getByDisplayValue('Members')).toBeEnabled();
  });
});

// An instance from before the hierarchy keeps every role at 0 and ranks
// nobody; there the client leaves every decision to the server, as before.
describe('a space on an instance from before the hierarchy', () => {
  beforeEach(() => {
    const flat = [EVERYONE, MODS, HELPERS, MEMBERS_ROLE].map((r) => ({ ...r, position: 0 }));
    const byId = (id: string) => flat.find((r) => r.id === id)!;
    useSpaceStore.setState({
      roles: flat,
      members: [
        member('owner', []),
        member('helper', [byId('r-helper')]),
        member('senior', [byId('r-mod')]),
        member('junior', [byId('r-member')]),
      ],
    });
  });

  it('offers kick, ban and every role checkbox in the Members panel', async () => {
    render(<MembersPanel spaceId={SPACE_ID} />);
    expect(within(rowOf('Senior')).getByRole('button', { name: 'Kick' })).toBeInTheDocument();
    expect(within(rowOf('Senior')).getByRole('button', { name: 'Ban' })).toBeInTheDocument();
    await userEvent.click(screen.getByText('Senior'));
    expect(screen.getByRole('checkbox', { name: 'Moderators' })).toBeEnabled();
  });

  it('keeps every role editable and Create Role enabled', async () => {
    render(<RolesPanel spaceId={SPACE_ID} />);
    expect(screen.getByRole('button', { name: 'Create Role' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Moderators' }));
    expect(screen.queryByText(/ranks at or above your highest role/)).toBeNull();
    expect(screen.getByDisplayValue('Moderators')).toBeEnabled();
  });
});
