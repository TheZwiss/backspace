import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { RolesPanel } from './RolesPanel';
import { useSpaceStore, type TaggedSpace } from '../../../stores/spaceStore';
import { useAuthStore } from '../../../stores/authStore';
import { useUIStore } from '../../../stores/uiStore';
import { api } from '../../../api/client';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString, stringToPermissions } from '../../../utils/permissions';

// The role editor locks the permission toggles the viewer cannot switch
// (permissions.md, "Held-bits rule").

const SPACE_ID = 'space-1';

const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

// The viewer's Leads role: MANAGE_ROLES and KICK_MEMBERS, nothing else.
const LEAD_BITS = PermissionBits.MANAGE_ROLES | PermissionBits.KICK_MEMBERS;
const EVERYONE_BITS = PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES;

function role(id: string, name: string, position: number, permissions: bigint): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: permissionsToString(permissions), createdAt: 1 };
}
const EVERYONE = role(SPACE_ID, '@everyone', 0, EVERYONE_BITS);
const LEADS = role('r-lead', 'Leads', 3, LEAD_BITS);
// Set up by the owner: carries BAN_MEMBERS, which the viewer does not hold.
const BANNERS = role('r-banner', 'Banners', 2, PermissionBits.BAN_MEMBERS);
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

const loadSpaceDetail = vi.fn(async () => undefined);

function seed(held: bigint): void {
  useAuthStore.setState({ user: user('lead') });
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    roles: [EVERYONE, LEADS, BANNERS, HELPERS],
    members: [member('owner', []), member('lead', [LEADS]), member('helper', [HELPERS])],
    spacePermissions: new Map([[SPACE_ID, permissionsToString(held)]]),
    loadSpaceDetail,
  });
}

const VIEWER_HELD = LEAD_BITS | EVERYONE_BITS;

async function openRole(name: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name }));
}

function toggle(name: string): HTMLElement {
  return screen.getByRole('switch', { name });
}

const LOCK_NOTE = /only switch permissions you have yourself/i;

beforeEach(() => {
  loadSpaceDetail.mockClear();
  useUIStore.setState({ isMobile: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('permission toggles the viewer does not hold', () => {
  it('are locked, with a note saying why, while held ones stay switchable', async () => {
    seed(VIEWER_HELD);
    render(<RolesPanel spaceId={SPACE_ID} />);
    await openRole('Helpers');

    expect(screen.getByText(LOCK_NOTE)).toBeInTheDocument();
    expect(toggle('Ban Members')).toHaveAttribute('aria-disabled', 'true');
    expect(toggle('Administrator')).toHaveAttribute('aria-disabled', 'true');
    expect(toggle('Kick Members')).toHaveAttribute('aria-disabled', 'false');
    expect(toggle('Send Messages')).toHaveAttribute('aria-disabled', 'false');

    await userEvent.click(toggle('Ban Members'));
    expect(toggle('Ban Members')).toHaveAttribute('aria-checked', 'false');
  });

  it('keep an unheld bit the role already has while the viewer switches the others', async () => {
    seed(VIEWER_HELD);
    const update = vi.spyOn(api.roles, 'update').mockResolvedValue(BANNERS);
    render(<RolesPanel spaceId={SPACE_ID} />);
    await openRole('Banners');

    expect(toggle('Ban Members')).toHaveAttribute('aria-checked', 'true');
    expect(toggle('Ban Members')).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(toggle('Ban Members'));
    await userEvent.click(toggle('Kick Members'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![2].permissions;
    expect(stringToPermissions(sent)).toBe(PermissionBits.BAN_MEMBERS | PermissionBits.KICK_MEMBERS);
  });

  it('lock @everyone\'s unheld toggles too', async () => {
    seed(VIEWER_HELD);
    render(<RolesPanel spaceId={SPACE_ID} />);
    await openRole('@everyone');
    expect(toggle('Administrator')).toHaveAttribute('aria-disabled', 'true');
    expect(toggle('Manage Space')).toHaveAttribute('aria-disabled', 'true');
    expect(toggle('Manage Roles')).toHaveAttribute('aria-disabled', 'false');
  });

  it('block copying a role that carries a bit the viewer does not hold, and say why', async () => {
    seed(VIEWER_HELD);
    render(<RolesPanel spaceId={SPACE_ID} />);
    await openRole('Banners');
    expect(screen.getByRole('button', { name: 'Copy Role' })).toBeDisabled();
    expect(screen.getByText(/so you cannot copy/i)).toBeInTheDocument();
  });

  it('block deleting a role that carries a bit the viewer does not hold, and say why', async () => {
    seed(VIEWER_HELD);
    const remove = vi.spyOn(api.roles, 'delete');
    render(<RolesPanel spaceId={SPACE_ID} />);
    await openRole('Banners');
    expect(screen.getByRole('button', { name: 'Delete Role' })).toBeDisabled();
    expect(screen.getByText(/cannot copy or delete it/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Role' }));
    expect(remove).not.toHaveBeenCalled();
  });

  it('keep Delete for a lower role whose bits the viewer holds', async () => {
    seed(VIEWER_HELD);
    render(<RolesPanel spaceId={SPACE_ID} />);
    await openRole('Helpers');
    expect(screen.getByRole('button', { name: 'Delete Role' })).toBeEnabled();
  });

  it('are not locked for a viewer who holds every permission', async () => {
    seed(ALL_PERMISSIONS);
    render(<RolesPanel spaceId={SPACE_ID} />);
    await openRole('Banners');
    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    expect(toggle('Administrator')).toHaveAttribute('aria-disabled', 'false');
    expect(toggle('Ban Members')).toHaveAttribute('aria-disabled', 'false');
    expect(screen.getByRole('button', { name: 'Copy Role' })).toBeEnabled();
  });

  it('are not locked while the viewer\'s permissions are not loaded; the server decides', async () => {
    seed(VIEWER_HELD);
    useSpaceStore.setState({ spacePermissions: new Map() });
    render(<RolesPanel spaceId={SPACE_ID} />);
    await openRole('Helpers');
    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    expect(toggle('Ban Members')).toHaveAttribute('aria-disabled', 'false');
  });

  it('can be switched from the keyboard when held', async () => {
    seed(VIEWER_HELD);
    render(<RolesPanel spaceId={SPACE_ID} />);
    await openRole('Helpers');
    toggle('Send Messages').focus();
    await userEvent.keyboard(' ');
    expect(toggle('Send Messages')).toHaveAttribute('aria-checked', 'true');
    toggle('Ban Members').focus();
    await userEvent.keyboard(' ');
    expect(toggle('Ban Members')).toHaveAttribute('aria-checked', 'false');
  });
});
