import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MemberWithUser, Role } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { PermissionsEditor, type Override } from './PermissionsEditor';
import { useSpaceStore } from '../../stores/spaceStore';
import { PermissionBits, permissionsToString } from '../../utils/permissions';
import type { PermissionDef } from './OverrideEntry';

const SPACE_ID = 'space-1';

function role(id: string, name: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: '0', createdAt: 1 };
}

const ROLES: Role[] = [
  role(SPACE_ID, '@everyone', 0),
  role('r-mod', 'Moderators', 2),
  role('r-guest', 'Guests', 1),
];

const MEMBERS: MemberWithUser[] = [];

const PERM_DEFS: PermissionDef[] = [
  { key: 'SEND_MESSAGES', bit: PermissionBits.SEND_MESSAGES },
  { key: 'ADD_REACTIONS', bit: PermissionBits.ADD_REACTIONS },
];

function override(targetId: string, allow: bigint, deny: bigint): Override {
  return { targetType: 'role', targetId, allow: permissionsToString(allow), deny: permissionsToString(deny) };
}

function memberOverride(targetId: string, allow: bigint, deny: bigint): Override {
  return { targetType: 'member', targetId, allow: permissionsToString(allow), deny: permissionsToString(deny) };
}

function member(userId: string, username: string, displayName: string | null): MemberWithUser {
  return {
    spaceId: SPACE_ID, userId, nickname: null, joinedAt: 1, roles: [],
    user: {
      id: userId, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null,
      bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
      homeInstance: null, homeUserId: null, replicatedInstances: [],
    },
  };
}

const UNHIDE_NOTE = 'Saving makes this channel visible to every member.';

function renderEditor(overrides: Override[], permDefs: PermissionDef[] = PERM_DEFS) {
  const deleteOverride = vi.fn().mockResolvedValue({ success: true });
  const putOverride = vi.fn().mockResolvedValue({ success: true });
  const getOverrides = vi.fn().mockResolvedValue(overrides);
  render(
    <PermissionsEditor
      entityId="channel-1"
      spaceId={SPACE_ID}
      permDefs={permDefs}
      unhideNote={UNHIDE_NOTE}
      getOverrides={getOverrides}
      putOverride={putOverride}
      deleteOverride={deleteOverride}
    />,
  );
  return { deleteOverride, putOverride, getOverrides };
}

beforeEach(() => {
  useSpaceStore.setState({ roles: ROLES, members: MEMBERS });
});

describe('PermissionsEditor: removing a role override (#290)', () => {
  it('gives each role override its own labelled remove control, outside the expand toggle', async () => {
    renderEditor([
      override(SPACE_ID, 0n, PermissionBits.SEND_MESSAGES),
      override('r-mod', PermissionBits.SEND_MESSAGES, 0n),
      override('r-guest', 0n, PermissionBits.ADD_REACTIONS),
    ]);

    const remove = await screen.findByRole('button', { name: 'Remove override for Moderators' });
    // A control nested in another button is neither valid HTML nor reachable
    // as its own control; the expand toggle and the remove action are siblings.
    expect(remove.parentElement?.closest('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove override for Guests' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove override for @everyone' })).toBeInTheDocument();
  });

  it('offers a labelled Remove override action inside the opened row, which deletes the row on save', async () => {
    const user = userEvent.setup();
    const { deleteOverride, putOverride } = renderEditor([
      override('r-mod', PermissionBits.SEND_MESSAGES, 0n),
      override('r-guest', 0n, PermissionBits.ADD_REACTIONS),
    ]);

    await user.click(await screen.findByRole('button', { name: /^Moderators/ }));
    const panel = screen.getByRole('region', { name: 'Moderators' });
    await user.click(within(panel).getByRole('button', { name: 'Remove override' }));

    expect(screen.queryByRole('button', { name: /^Moderators/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(deleteOverride).toHaveBeenCalledWith('role', 'r-mod'));
    expect(deleteOverride).toHaveBeenCalledTimes(1);
    expect(putOverride).not.toHaveBeenCalled();
  });

  it('says so when a channel has no role or member overrides', async () => {
    renderEditor([]);
    expect(await screen.findByText('No role overrides. Every role uses its space-wide permissions here.')).toBeInTheDocument();
    expect(screen.getByText('No member overrides.')).toBeInTheDocument();
  });
});

describe('PermissionsEditor: removing the @everyone override (#314)', () => {
  it('stages the @everyone removal like any role and deletes the role:<spaceId> row on save', async () => {
    const user = userEvent.setup();
    const { deleteOverride, putOverride } = renderEditor([
      override(SPACE_ID, 0n, PermissionBits.SEND_MESSAGES),
      override('r-mod', PermissionBits.SEND_MESSAGES, 0n),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Remove override for @everyone' }));
    expect(screen.queryByRole('button', { name: /^@everyone/ })).toBeNull();
    // Staged, not sent: nothing reaches the server before Save.
    expect(deleteOverride).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(deleteOverride).toHaveBeenCalledWith('role', SPACE_ID));
    expect(deleteOverride).toHaveBeenCalledTimes(1);
    expect(putOverride).not.toHaveBeenCalled();
  });

  it('offers the labelled Remove override action inside the opened @everyone row', async () => {
    const user = userEvent.setup();
    renderEditor([override(SPACE_ID, 0n, PermissionBits.SEND_MESSAGES)]);

    await user.click(await screen.findByRole('button', { name: /^@everyone/ }));
    const panel = screen.getByRole('region', { name: '@everyone' });
    expect(within(panel).getByRole('button', { name: 'Remove override' })).toBeInTheDocument();
  });
});

describe('PermissionsEditor: the add pickers follow the staged rows (#314)', () => {
  it('offers a role again in Add Role right after its override is removed, before saving', async () => {
    const user = userEvent.setup();
    const { deleteOverride, putOverride } = renderEditor([
      override(SPACE_ID, 0n, PermissionBits.SEND_MESSAGES),
      override('r-mod', PermissionBits.SEND_MESSAGES, 0n),
      override('r-guest', 0n, PermissionBits.ADD_REACTIONS),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Remove override for Moderators' }));
    await user.click(screen.getByRole('button', { name: 'Add Role' }));
    // Roles that still have a row stay out of the picker.
    expect(screen.queryByRole('button', { name: 'Guests' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Moderators' }));

    // Re-added as a fresh, empty override in the same edit.
    expect(screen.getByRole('button', { name: 'Remove override for Moderators' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putOverride).toHaveBeenCalledWith({ targetType: 'role', targetId: 'r-mod', allow: '0', deny: '0' }));
    expect(deleteOverride).not.toHaveBeenCalled();
  });

  it('removes a saved role that was removed, re-added and removed again in one edit', async () => {
    const user = userEvent.setup();
    const { deleteOverride, putOverride } = renderEditor([
      override('r-mod', PermissionBits.SEND_MESSAGES, 0n),
      override('r-guest', 0n, PermissionBits.ADD_REACTIONS),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Remove override for Moderators' }));
    await user.click(screen.getByRole('button', { name: 'Add Role' }));
    await user.click(screen.getByRole('button', { name: 'Moderators' }));
    await user.click(screen.getByRole('button', { name: 'Remove override for Moderators' }));

    expect(screen.queryByRole('button', { name: /^Moderators/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(deleteOverride).toHaveBeenCalledWith('role', 'r-mod'));
    expect(putOverride).not.toHaveBeenCalled();
  });

  it('offers @everyone in Add Role after its override is removed', async () => {
    const user = userEvent.setup();
    renderEditor([
      override(SPACE_ID, 0n, PermissionBits.SEND_MESSAGES),
      override('r-mod', PermissionBits.SEND_MESSAGES, 0n),
      override('r-guest', 0n, PermissionBits.ADD_REACTIONS),
    ]);

    await user.click(await screen.findByRole('button', { name: 'Add Role' }));
    expect(screen.getByText('No more roles to add')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Remove override for @everyone' }));
    await user.click(screen.getByRole('button', { name: 'Add Role' }));
    expect(screen.getByRole('button', { name: '@everyone' })).toBeInTheDocument();
  });

  it('offers a member again in Add Member right after their override is removed, before saving', async () => {
    const user = userEvent.setup();
    useSpaceStore.setState({ members: [member('u-mira', 'mira', 'Mira'), member('u-kai', 'kai', null)] });
    renderEditor([memberOverride('u-mira', PermissionBits.ATTACH_FILES, 0n)]);

    await user.click(await screen.findByRole('button', { name: 'Remove override for Mira' }));
    await user.click(screen.getByRole('button', { name: 'Add Member' }));
    expect(screen.getByRole('button', { name: /^Mira/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'kai' })).toBeInTheDocument();
  });
});

describe('PermissionsEditor: saving that unhides a private channel says so', () => {
  const WITH_VIEW: PermissionDef[] = [{ key: 'VIEW_CHANNEL', bit: PermissionBits.VIEW_CHANNEL }, ...PERM_DEFS];

  it('shows the note when the @everyone row that denies View Channels is removed, and Discard hides it', async () => {
    const user = userEvent.setup();
    renderEditor([override(SPACE_ID, 0n, PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES)], WITH_VIEW);

    await screen.findByRole('button', { name: /^@everyone/ });
    expect(screen.queryByText(UNHIDE_NOTE)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Remove override for @everyone' }));
    expect(screen.getByText(UNHIDE_NOTE)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText(UNHIDE_NOTE)).toBeNull();
  });

  it('shows the note when the View Channels deny on @everyone is cleared', async () => {
    const user = userEvent.setup();
    renderEditor([override(SPACE_ID, 0n, PermissionBits.VIEW_CHANNEL)], WITH_VIEW);

    await user.click(await screen.findByRole('button', { name: /^@everyone/ }));
    const row = screen.getByText('View Channels').parentElement!;
    await user.click(within(row).getByTitle('Neutral (inherit)'));
    expect(screen.getByText(UNHIDE_NOTE)).toBeInTheDocument();

    await user.click(within(row).getByTitle('Deny'));
    expect(screen.queryByText(UNHIDE_NOTE)).toBeNull();
  });

  it('stays quiet when the removed @everyone row did not hide the channel', async () => {
    const user = userEvent.setup();
    renderEditor([override(SPACE_ID, 0n, PermissionBits.SEND_MESSAGES)], WITH_VIEW);

    await user.click(await screen.findByRole('button', { name: 'Remove override for @everyone' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.queryByText(UNHIDE_NOTE)).toBeNull();
  });
});
