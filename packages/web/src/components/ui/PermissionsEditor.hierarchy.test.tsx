import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { PermissionsEditor, type Override } from './PermissionsEditor';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../../utils/permissions';
import type { PermissionDef } from './OverrideEntry';

// Channel and category overrides follow the role hierarchy
// (permissions.md, "Role hierarchy"): an override on a role or member at or
// above the viewer is shown read-only, and such targets are not offered in
// the add pickers.

const SPACE_ID = 'space-1';
const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

function role(id: string, name: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: '0', createdAt: 1 };
}
const EVERYONE = role(SPACE_ID, '@everyone', 0);
const MODS = role('r-mod', 'Moderators', 3);
const HELPERS = role('r-helper', 'Helpers', 2);
const GUESTS = role('r-guest', 'Guests', 1);

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

const PERM_DEFS: PermissionDef[] = [
  { key: 'VIEW_CHANNEL', bit: PermissionBits.VIEW_CHANNEL },
  { key: 'SEND_MESSAGES', bit: PermissionBits.SEND_MESSAGES },
];

function roleOverride(targetId: string, deny: bigint): Override {
  return { targetType: 'role', targetId, allow: '0', deny: permissionsToString(deny) };
}
function memberOverride(targetId: string, deny: bigint): Override {
  return { targetType: 'member', targetId, allow: '0', deny: permissionsToString(deny) };
}

function renderEditor(overrides: Override[]) {
  const deleteOverride = vi.fn().mockResolvedValue({ success: true });
  const putOverride = vi.fn().mockResolvedValue({ success: true });
  render(
    <PermissionsEditor
      entityId="channel-1"
      spaceId={SPACE_ID}
      permDefs={PERM_DEFS}
      unhideNote="Saving makes this channel visible to every member."
      overrides={overrides}
      onSaved={vi.fn()}
      putOverride={putOverride}
      deleteOverride={deleteOverride}
    />,
  );
  return { deleteOverride, putOverride };
}

async function open(name: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }));
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  // The viewer holds Helpers (2): Moderators ranks above them, Guests below.
  useAuthStore.setState({ user: user('helper') });
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    roles: [EVERYONE, MODS, HELPERS, GUESTS],
    members: [member('owner', []), member('helper', [HELPERS]), member('senior', [MODS]), member('junior', [GUESTS])],
    // Every bit held, so only the hierarchy locks anything here.
    spacePermissions: new Map([[SPACE_ID, permissionsToString(ALL_PERMISSIONS)]]),
  });
});

describe('an override on a target at or above the viewer', () => {
  it('is read-only for a higher role, with the reason, and cannot be removed', async () => {
    renderEditor([roleOverride('r-mod', PermissionBits.SEND_MESSAGES), roleOverride('r-guest', PermissionBits.SEND_MESSAGES)]);
    expect(await screen.findByRole('button', { name: 'Remove override for Moderators' })).toBeDisabled();

    const panel = await open('Moderators');
    expect(within(panel).getByText(/ranks at or above your highest role/i)).toBeInTheDocument();
    for (const group of within(panel).getAllByRole('group')) {
      for (const button of within(group).getAllByRole('button')) expect(button).toBeDisabled();
    }
    expect(within(panel).queryByRole('button', { name: 'Remove override' })).toBeNull();
  });

  it('stays editable for a lower role', async () => {
    renderEditor([roleOverride('r-guest', PermissionBits.SEND_MESSAGES)]);
    expect(await screen.findByRole('button', { name: 'Remove override for Guests' })).toBeEnabled();
    const panel = await open('Guests');
    expect(within(within(panel).getByRole('group', { name: 'Send Messages' })).getByRole('button', { name: 'Allow' })).toBeEnabled();
  });

  it('is read-only for a higher member, editable for a lower one', async () => {
    renderEditor([memberOverride('senior', PermissionBits.SEND_MESSAGES), memberOverride('junior', PermissionBits.SEND_MESSAGES)]);
    expect(await screen.findByRole('button', { name: 'Remove override for Senior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove override for Junior' })).toBeEnabled();
    const panel = await open('Senior');
    expect(within(panel).getByText(/ranks at or above you/i)).toBeInTheDocument();
  });
});

describe('the add pickers', () => {
  it('offer only roles below the viewer\'s top role', async () => {
    renderEditor([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Add Role' }));
    expect(screen.getByRole('button', { name: 'Guests' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '@everyone' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Moderators' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Helpers' })).toBeNull();
  });

  it('offer only members the viewer outranks, and the viewer themselves', async () => {
    renderEditor([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Add Member' }));
    expect(screen.getByRole('button', { name: /^Junior/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Helper/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Senior/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Owner/ })).toBeNull();
  });
});

describe('a space on an instance from before the hierarchy', () => {
  it('leaves every override editable and every target in the pickers', async () => {
    const flat = [EVERYONE, MODS, HELPERS, GUESTS].map((r) => ({ ...r, position: 0 }));
    useSpaceStore.setState({
      roles: flat,
      members: [member('owner', []), member('helper', [flat[2]!]), member('senior', [flat[1]!]), member('junior', [flat[3]!])],
    });
    renderEditor([roleOverride('r-mod', PermissionBits.SEND_MESSAGES)]);
    expect(await screen.findByRole('button', { name: 'Remove override for Moderators' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Add Member' }));
    expect(screen.getByRole('button', { name: /^Senior/ })).toBeInTheDocument();
  });
});
