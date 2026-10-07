import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Role } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { PermissionsEditor, type Override } from './PermissionsEditor';
import { useSpaceStore } from '../../stores/spaceStore';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../../utils/permissions';
import type { PermissionDef } from './OverrideEntry';

// The channel and category override editor locks the permissions the viewer
// cannot switch and the removal of an override that sets one
// (permissions.md, "Held-bits rule").

const SPACE_ID = 'space-1';

function role(id: string, name: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: '0', createdAt: 1 };
}

const ROLES: Role[] = [
  role(SPACE_ID, '@everyone', 0),
  role('r-mod', 'Moderators', 2),
  role('r-guest', 'Guests', 1),
];

const PERM_DEFS: PermissionDef[] = [
  { key: 'SEND_MESSAGES', bit: PermissionBits.SEND_MESSAGES },
  { key: 'MANAGE_MESSAGES', bit: PermissionBits.MANAGE_MESSAGES },
];

// The viewer manages roles and can send messages; they do not hold MANAGE_MESSAGES.
const VIEWER_HELD = PermissionBits.MANAGE_ROLES | PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES;

function override(targetId: string, allow: bigint, deny: bigint): Override {
  return { targetType: 'role', targetId, allow: permissionsToString(allow), deny: permissionsToString(deny) };
}

function seed(held: bigint | null): void {
  useSpaceStore.setState({
    roles: ROLES,
    members: [],
    spacePermissions: held === null ? new Map() : new Map([[SPACE_ID, permissionsToString(held)]]),
  });
}

function renderEditor(overrides: Override[]) {
  const deleteOverride = vi.fn().mockResolvedValue({ success: true });
  const putOverride = vi.fn().mockResolvedValue({ success: true });
  const onSaved = vi.fn();
  render(
    <PermissionsEditor
      entityId="channel-1"
      spaceId={SPACE_ID}
      permDefs={PERM_DEFS}
      unhideNote="Saving makes this channel visible to every member."
      overrides={overrides}
      onSaved={onSaved}
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

const LOCK_NOTE = /only switch permissions you have yourself/i;

beforeEach(() => {
  seed(VIEWER_HELD);
});

describe('a permission the viewer does not hold', () => {
  it('cannot be switched in any direction, keeps showing its state, and the row says why', async () => {
    renderEditor([override('r-guest', PermissionBits.MANAGE_MESSAGES, 0n)]);
    const panel = await open('Guests');

    expect(within(panel).getByText(LOCK_NOTE)).toBeInTheDocument();
    const manage = within(panel).getByRole('group', { name: 'Manage Messages' });
    for (const name of ['Deny', 'Neutral (inherit)', 'Allow']) {
      expect(within(manage).getByRole('button', { name })).toBeDisabled();
    }
    expect(within(manage).getByRole('button', { name: 'Allow' })).toHaveAttribute('aria-pressed', 'true');

    const send = within(panel).getByRole('group', { name: 'Send Messages' });
    expect(within(send).getByRole('button', { name: 'Deny' })).toBeEnabled();
  });

  it('stays as it is on save while the viewer edits the permissions they hold', async () => {
    const { putOverride } = renderEditor([override('r-guest', PermissionBits.MANAGE_MESSAGES, 0n)]);
    const panel = await open('Guests');
    await userEvent.click(within(within(panel).getByRole('group', { name: 'Manage Messages' })).getByRole('button', { name: 'Deny' }));
    await userEvent.click(within(within(panel).getByRole('group', { name: 'Send Messages' })).getByRole('button', { name: 'Deny' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putOverride).toHaveBeenCalledWith({
      targetType: 'role',
      targetId: 'r-guest',
      allow: permissionsToString(PermissionBits.MANAGE_MESSAGES),
      deny: permissionsToString(PermissionBits.SEND_MESSAGES),
    }));
  });
});

describe('removing an override', () => {
  it('is locked when the saved override sets a permission the viewer does not hold, with the reason', async () => {
    const { deleteOverride } = renderEditor([override('r-guest', PermissionBits.MANAGE_MESSAGES, 0n)]);
    expect(await screen.findByRole('button', { name: 'Remove override for Guests' })).toBeDisabled();

    const panel = await open('Guests');
    expect(within(panel).getByRole('button', { name: 'Remove override' })).toBeDisabled();
    expect(within(panel).getByText(/Only someone who has them can remove it/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove override for Guests' }));
    expect(screen.getByRole('button', { name: /^Guests/ })).toBeInTheDocument();
    expect(deleteOverride).not.toHaveBeenCalled();
  });

  it('stays open for an override that only sets permissions the viewer holds', async () => {
    renderEditor([override('r-mod', 0n, PermissionBits.SEND_MESSAGES)]);
    expect(await screen.findByRole('button', { name: 'Remove override for Moderators' })).toBeEnabled();
    const panel = await open('Moderators');
    expect(within(panel).queryByText(LOCK_NOTE)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Remove override' })).toBeEnabled();
  });
});

describe('a viewer who is not limited', () => {
  it('holding every permission sees nothing locked', async () => {
    seed(ALL_PERMISSIONS);
    renderEditor([override('r-guest', PermissionBits.MANAGE_MESSAGES, 0n)]);
    expect(await screen.findByRole('button', { name: 'Remove override for Guests' })).toBeEnabled();
    const panel = await open('Guests');
    expect(within(panel).queryByText(LOCK_NOTE)).toBeNull();
    expect(within(within(panel).getByRole('group', { name: 'Manage Messages' })).getByRole('button', { name: 'Deny' })).toBeEnabled();
  });

  it('whose permissions are not loaded sees nothing locked; the server decides', async () => {
    seed(null);
    renderEditor([override('r-guest', PermissionBits.MANAGE_MESSAGES, 0n)]);
    expect(await screen.findByRole('button', { name: 'Remove override for Guests' })).toBeEnabled();
  });
});
