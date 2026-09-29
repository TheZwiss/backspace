import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Channel, ChannelCategory, Role } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

interface Row { targetType: string; targetId: string; allow: string; deny: string }

// The override routes of both entities, answered from one in-memory table.
let rows: Row[] = [];
const put = vi.fn(async (_id: string, data: Row) => {
  rows = [...rows.filter((r) => !(r.targetType === data.targetType && r.targetId === data.targetId)), data];
  return { success: true };
});
const remove = vi.fn(async (_id: string, targetType: string, targetId: string) => {
  rows = rows.filter((r) => !(r.targetType === targetType && r.targetId === targetId));
  return { success: true };
});
const get = vi.fn(async () => rows.map((r) => ({ ...r })));
const routes = { getOverrides: get, putOverride: put, deleteOverride: remove };

vi.mock('../../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({ channels: routes, categories: routes }),
}));

import { ChannelSettingsModal } from './ChannelSettingsModal';
import { CategorySettingsModal } from './CategorySettingsModal';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString, stringToPermissions } from '../../utils/permissions';

// #327 and #365: privacy is @everyone's View Channels deny, one bit of one
// override. Switching it touches that bit only, and the Overview reads the
// same overrides the Permissions tab edits.

const SPACE_ID = 'space-1';
const VIEW = PermissionBits.VIEW_CHANNEL;
const SEND = PermissionBits.SEND_MESSAGES;

const space: TaggedSpace = {
  id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender', ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: '', createdAt: 1, _instanceOrigin: '',
};
const channel: Channel = { id: 'channel-1', spaceId: SPACE_ID, name: 'events', type: 'text', topic: null, position: 0, categoryId: null, createdAt: 1 };
const category: ChannelCategory = { id: 'category-1', spaceId: SPACE_ID, name: 'Staff', position: 0, createdAt: 1 };

function role(id: string, name: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, permissions: '0', createdAt: 1 };
}

function row(targetId: string, allow: bigint, deny: bigint): Row {
  return { targetType: 'role', targetId, allow: permissionsToString(allow), deny: permissionsToString(deny) };
}

const everyoneRow = (): Row | undefined => rows.find((r) => r.targetId === SPACE_ID);

type Kind = 'channel' | 'category';

function open(kind: Kind): void {
  const all = permissionsToString(ALL_PERMISSIONS);
  useSpaceStore.setState({
    spaces: [space],
    currentSpaceId: SPACE_ID,
    channels: [channel],
    categories: [category],
    roles: [role(SPACE_ID, '@everyone', 0), role('r-guest', 'Guests', 1), role('r-mod', 'Moderators', 3), role('r-member', 'Members', 2)],
    members: [],
    spacePermissions: new Map([[SPACE_ID, all]]),
    channelPermissions: new Map([['channel-1', all]]),
  });
  useUIStore.setState(kind === 'channel'
    ? { activeModal: 'channelSettings', modalData: { channelId: 'channel-1' } }
    : { activeModal: 'categorySettings', modalData: { categoryId: 'category-1' } });
  render(kind === 'channel' ? <ChannelSettingsModal /> : <CategorySettingsModal />);
}

const privacySwitch = (): HTMLElement => screen.getByRole('switch');
const lockNote = (kind: Kind) => screen.queryByText(kind === 'channel'
  ? /This channel is hidden from members without explicit access/
  : /This category is hidden from members without explicit access/);

beforeEach(() => {
  rows = [];
  put.mockClear();
  remove.mockClear();
  get.mockClear();
});

describe.each<Kind>(['channel', 'category'])('%s privacy', (kind) => {
  it('making it public clears only the View Channels deny and keeps the other @everyone bits', async () => {
    rows = [row(SPACE_ID, 0n, VIEW | SEND)];
    open(kind);
    await waitFor(() => expect(privacySwitch()).toHaveAttribute('aria-checked', 'true'));

    await userEvent.click(privacySwitch());

    await waitFor(() => expect(privacySwitch()).toHaveAttribute('aria-checked', 'false'));
    expect(remove).not.toHaveBeenCalled();
    expect(stringToPermissions(everyoneRow()!.deny)).toBe(SEND);
  });

  it('making it public removes the @everyone override when View Channels was its only bit', async () => {
    rows = [row(SPACE_ID, 0n, VIEW)];
    open(kind);
    await waitFor(() => expect(privacySwitch()).toHaveAttribute('aria-checked', 'true'));

    await userEvent.click(privacySwitch());

    await waitFor(() => expect(everyoneRow()).toBeUndefined());
    expect(remove).toHaveBeenCalledWith(expect.any(String), 'role', SPACE_ID);
  });

  it('making it private adds the View Channels deny to the @everyone bits already there', async () => {
    rows = [row(SPACE_ID, PermissionBits.ADD_REACTIONS | VIEW, SEND)];
    open(kind);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(privacySwitch()).toHaveAttribute('aria-checked', 'false'));

    await userEvent.click(privacySwitch());

    await waitFor(() => expect(privacySwitch()).toHaveAttribute('aria-checked', 'true'));
    expect(everyoneRow()).toEqual(row(SPACE_ID, PermissionBits.ADD_REACTIONS, VIEW | SEND));
  });

  it('the Overview follows a save on the Permissions tab without reopening', async () => {
    rows = [row(SPACE_ID, 0n, VIEW)];
    open(kind);
    await waitFor(() => expect(privacySwitch()).toHaveAttribute('aria-checked', 'true'));
    expect(lockNote(kind)).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove override for @everyone' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(everyoneRow()).toBeUndefined());
    await userEvent.click(screen.getByRole('button', { name: 'Overview' }));

    await waitFor(() => expect(privacySwitch()).toHaveAttribute('aria-checked', 'false'));
    expect(lockNote(kind)).toBeNull();
  });

  it('lists role overrides in rank order, highest first and @everyone last', async () => {
    rows = [row(SPACE_ID, 0n, SEND), row('r-guest', SEND, 0n), row('r-mod', SEND, 0n), row('r-member', SEND, 0n)];
    open(kind);
    await userEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    await screen.findByRole('button', { name: 'Remove override for Moderators' });

    const names = screen.getAllByRole('button', { name: /^Remove override for / })
      .map((b) => b.getAttribute('aria-label')!.replace('Remove override for ', ''));
    expect(names).toEqual(['Moderators', 'Members', 'Guests', '@everyone']);
    expect(within(document.body).queryAllByRole('button', { name: /^Remove override for / })).toHaveLength(4);
  });
});
