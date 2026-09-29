import type { SpaceWithChannelsAndMembers, User } from '@backspace/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

import { api } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { setMyUserIdForOrigin, useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { OwnerTitleHeading } from './OwnerTitleHeading';

const space: TaggedSpace = {
  id: 'space', name: 'Space', icon: null, banner: null, avatarColor: null,
  ownerId: 'owner', ownerTitle: null, inviteCode: null, visibility: 'private',
  directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};
const user: User = {
  id: 'owner', username: 'owner', displayName: null, avatar: null, banner: null,
  accentColor: null, avatarColor: null, bio: null, status: 'online', customStatus: null,
  isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: [],
};

function Heading() {
  const current = useSpaceStore((s) => s.spaces[0]!);
  return <OwnerTitleHeading key={current.id} space={current} count={1} />;
}

beforeEach(() => {
  vi.restoreAllMocks();
  useSpaceStore.getState().reset();
  useSpaceStore.setState({ spaces: [{ ...space }] });
  useAuthStore.setState({ user });
});

describe('owner title heading', () => {
  it('shows the default heading and makes the editor available to the owner', async () => {
    render(<Heading />);
    expect(screen.getByRole('heading', { name: 'Owner — 1' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit owner title' }));
    expect(screen.getByLabelText('Owner title')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  });

  it('saves through the API and displays only the confirmed server response', async () => {
    let confirm!: (value: TaggedSpace) => void;
    const update = vi.spyOn(api.spaces, 'update').mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
    render(<Heading />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit owner title' }));
    await userEvent.type(screen.getByLabelText('Owner title'), '  首席摸鱼官  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenCalledWith('space', { ownerTitle: '首席摸鱼官' });
    expect(screen.getByRole('heading', { name: 'Owner — 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => confirm({ ...space, ownerTitle: '首席摸鱼官' }));
    expect(screen.getByRole('heading', { name: '首席摸鱼官 — 1' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Owner title')).not.toBeInTheDocument();
  });

  it('exposes failed writes without silently changing or closing the editor', async () => {
    vi.spyOn(api.spaces, 'update').mockRejectedValue(new Error('Database is unavailable'));
    render(<Heading />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit owner title' }));
    await userEvent.type(screen.getByLabelText('Owner title'), 'Captain');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is unavailable');
    expect(screen.getByLabelText('Owner title')).toHaveValue('Captain');
    expect(screen.getByRole('heading', { name: 'Owner — 1' })).toBeInTheDocument();
  });

  it('does not save when cancelled', async () => {
    const update = vi.spyOn(api.spaces, 'update');
    render(<Heading />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit owner title' }));
    await userEvent.type(screen.getByLabelText('Owner title'), 'Captain');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(update).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Owner title')).not.toBeInTheDocument();
  });

  it('rejects whitespace instead of silently restoring the default', async () => {
    const update = vi.spyOn(api.spaces, 'update');
    render(<Heading />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit owner title' }));
    await userEvent.type(screen.getByLabelText('Owner title'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('1–32');
    expect(update).not.toHaveBeenCalled();
  });

  it('preserves custom capitalization for viewers and hides editing from non-owners', () => {
    useAuthStore.setState({ user: { ...user, id: 'member', isAdmin: true } });
    useSpaceStore.setState({ spaces: [{ ...space, ownerTitle: 'Captain Ada' }] });
    render(<Heading />);
    expect(screen.getByRole('heading', { name: 'Captain Ada — 1' })).not.toHaveClass('uppercase');
    expect(screen.queryByRole('button', { name: 'Edit owner title' })).not.toBeInTheDocument();
  });

  it('resets the persisted title explicitly', async () => {
    useSpaceStore.setState({ spaces: [{ ...space, ownerTitle: 'Captain' }] });
    const update = vi.spyOn(api.spaces, 'update').mockResolvedValue({ ...space });
    render(<Heading />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit owner title' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(update).toHaveBeenCalledWith('space', { ownerTitle: null });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Owner — 1' })).toBeInTheDocument());
  });

  it('uses the owner’s ID on the remote host rather than their home account ID', () => {
    const origin = 'https://peer.example';
    setMyUserIdForOrigin(origin, 'remote-owner');
    useSpaceStore.setState({ spaces: [{ ...space, ownerId: 'remote-owner', _instanceOrigin: origin }] });
    render(<Heading />);
    expect(screen.getByRole('button', { name: 'Edit owner title' })).toBeInTheDocument();
  });

  it.each(['', 'https://peer.example'])('retains the title from ready and newly joined space payloads at %s', (origin) => {
    const detail: SpaceWithChannelsAndMembers = { ...space, ownerTitle: '首席摸鱼官', channels: [], categories: [], members: [], roles: [], myPermissions: '0' };
    useSpaceStore.getState().populateFromReady(origin, [detail]);
    expect(useSpaceStore.getState().spaces.find((s) => s._instanceOrigin === origin)?.ownerTitle).toBe('首席摸鱼官');
    useSpaceStore.getState().addSpaceFromReady(origin, { ...detail, id: 'joined', ownerTitle: 'Captain' });
    expect(useSpaceStore.getState().spaces.find((s) => s.id === 'joined')?.ownerTitle).toBe('Captain');
  });
});
