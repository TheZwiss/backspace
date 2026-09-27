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

function renderEditor(overrides: Override[]) {
  const deleteOverride = vi.fn().mockResolvedValue({ success: true });
  const putOverride = vi.fn().mockResolvedValue({ success: true });
  const getOverrides = vi.fn().mockResolvedValue(overrides);
  render(
    <PermissionsEditor
      entityId="channel-1"
      spaceId={SPACE_ID}
      permDefs={PERM_DEFS}
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
    // @everyone is the base row of every channel and carries the private flag.
    expect(screen.queryByRole('button', { name: 'Remove override for @everyone' })).toBeNull();
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
