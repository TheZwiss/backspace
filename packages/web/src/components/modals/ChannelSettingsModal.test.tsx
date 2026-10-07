import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Channel } from '@backspace/shared';

// Stub AudioManager to avoid an AudioWorkletNode reference error in jsdom.
// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

const mockGetOverrides = vi.fn();
const mockUpdateChannel = vi.fn();
// Mocked where it is defined, so the modal and the store's own actions both
// reach the stub.
vi.mock('../../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    channels: {
      getOverrides: (...args: unknown[]) => mockGetOverrides(...args),
      update: (...args: unknown[]) => mockUpdateChannel(...args),
    },
  }),
}));

import { ChannelSettingsModal } from './ChannelSettingsModal';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { PermissionBits, permissionsToString } from '../../utils/permissions';
import { HttpError } from '../../api/client';

const space: TaggedSpace = {
  id: 'space-1',
  name: 'Aether Drift',
  icon: null,
  banner: null,
  avatarColor: 'lavender',
  ownerId: 'someone-else',
  inviteCode: null,
  visibility: 'public',
  directoryListed: false,
  description: '',
  createdAt: 1,
  _instanceOrigin: '',
};

const channel: Channel = {
  id: 'channel-1',
  spaceId: 'space-1',
  name: 'events',
  type: 'text',
  topic: null,
  position: 0,
  categoryId: null,
  createdAt: 1,
};

const bits = (...b: bigint[]) => permissionsToString(b.reduce((acc, x) => acc | x, 0n));

function seed(spacePerms: string, channelPerms: string): void {
  useSpaceStore.setState({
    spaces: [space],
    currentSpaceId: 'space-1',
    channels: [channel],
    spacePermissions: new Map([['space-1', spacePerms]]),
    channelPermissions: new Map([['channel-1', channelPerms]]),
  });
  useUIStore.setState({ activeModal: 'channelSettings', modalData: { channelId: 'channel-1' } });
}

beforeEach(() => {
  mockGetOverrides.mockReset();
  mockGetOverrides.mockResolvedValue([]);
  mockUpdateChannel.mockReset();
});

// Each control reads the permissions at the scope its server route checks:
// PATCH/DELETE /api/channels/:id resolve MANAGE_CHANNELS with this channel's
// overrides, the override routes check MANAGE_ROLES space-wide.
describe('ChannelSettingsModal permission scope', () => {
  it('offers delete when only a channel override grants MANAGE_CHANNELS', () => {
    seed(bits(PermissionBits.VIEW_CHANNEL), bits(PermissionBits.VIEW_CHANNEL, PermissionBits.MANAGE_CHANNELS));
    render(<ChannelSettingsModal />);
    expect(screen.getByRole('button', { name: 'Delete Channel' })).toBeTruthy();
  });

  it('hides delete when a channel override denies the space-wide MANAGE_CHANNELS', () => {
    seed(bits(PermissionBits.VIEW_CHANNEL, PermissionBits.MANAGE_CHANNELS), bits(PermissionBits.VIEW_CHANNEL));
    render(<ChannelSettingsModal />);
    expect(screen.queryByRole('button', { name: 'Delete Channel' })).toBeNull();
  });

  it('without MANAGE_ROLES neither fetches overrides nor shows the privacy row', async () => {
    const manage = bits(PermissionBits.VIEW_CHANNEL, PermissionBits.MANAGE_CHANNELS);
    seed(manage, manage);
    render(<ChannelSettingsModal />);
    expect(screen.getByRole('button', { name: 'Delete Channel' })).toBeTruthy();
    expect(screen.queryByText('Private Channel')).toBeNull();
    expect(mockGetOverrides).not.toHaveBeenCalled();
  });

  it('with MANAGE_ROLES fetches overrides and shows the privacy row', async () => {
    const manage = bits(PermissionBits.VIEW_CHANNEL, PermissionBits.MANAGE_CHANNELS, PermissionBits.MANAGE_ROLES);
    seed(manage, manage);
    render(<ChannelSettingsModal />);
    expect(screen.getByText('Private Channel')).toBeTruthy();
    await waitFor(() => expect(mockGetOverrides).toHaveBeenCalledWith('channel-1'));
  });
});

describe('ChannelSettingsModal rename', () => {
  const manage = bits(PermissionBits.VIEW_CHANNEL, PermissionBits.MANAGE_CHANNELS);

  it('saves through the store and shows the name the server stored', async () => {
    seed(manage, manage);
    useSpaceStore.getState().channelOriginMap.set('channel-1', '');
    mockUpdateChannel.mockImplementation((_id: string, data: { name: string }) =>
      Promise.resolve({ ...channel, name: data.name.toLowerCase().replace(/\s+/g, '-') }));
    const user = userEvent.setup();
    render(<ChannelSettingsModal />);
    await user.click(screen.getByRole('button', { name: /Rename Channel/ }));
    const field = screen.getByRole('textbox', { name: 'Channel Name' });
    await user.clear(field);
    await user.type(field, 'Game Night{Enter}');
    expect(mockUpdateChannel).toHaveBeenCalledWith('channel-1', { name: 'Game Night' });
    await waitFor(() => expect(screen.getByRole('button', { name: /Rename Channel/ }).textContent).toContain('game-night'));
    expect(useSpaceStore.getState().channels[0].name).toBe('game-night');
  });

  it('shows the server error and keeps the editor open', async () => {
    seed(manage, manage);
    mockUpdateChannel.mockRejectedValue(new HttpError(403, 'Missing MANAGE_CHANNELS permission', undefined, 'missing_permission', { permission: 'MANAGE_CHANNELS' }));
    const user = userEvent.setup();
    render(<ChannelSettingsModal />);
    await user.click(screen.getByRole('button', { name: /Rename Channel/ }));
    const field = screen.getByRole('textbox', { name: 'Channel Name' });
    await user.clear(field);
    await user.type(field, 'renamed{Enter}');
    await waitFor(() => expect(screen.getByText(/permission to do that/)).toBeTruthy());
    expect((screen.getByRole('textbox', { name: 'Channel Name' }) as HTMLInputElement).value).toBe('renamed');
  });
});

describe('ChannelSettingsModal topic', () => {
  const manage = bits(PermissionBits.VIEW_CHANNEL, PermissionBits.MANAGE_CHANNELS);

  it('edits the topic of an existing channel through the store', async () => {
    seed(manage, manage);
    useSpaceStore.getState().channelOriginMap.set('channel-1', '');
    mockUpdateChannel.mockImplementation((_id: string, data: { topic: string | null }) =>
      Promise.resolve({ ...channel, topic: data.topic }));
    const user = userEvent.setup();
    render(<ChannelSettingsModal />);
    const field = screen.getByRole('textbox', { name: 'Topic' });
    await user.type(field, '  Weekly game night  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockUpdateChannel).toHaveBeenCalledWith('channel-1', { topic: 'Weekly game night' });
    await waitFor(() => expect(useSpaceStore.getState().channels[0].topic).toBe('Weekly game night'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  });

  it('shows the server error for a refused topic and keeps the typed text', async () => {
    seed(manage, manage);
    mockUpdateChannel.mockRejectedValue(new HttpError(400, 'Channel topic can be at most 1024 characters', undefined, 'channel_topic_length', { max: 1024 }));
    const user = userEvent.setup();
    render(<ChannelSettingsModal />);
    const field = screen.getByRole('textbox', { name: 'Topic' });
    await user.type(field, 'Refused');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Channel topics can be at most 1024 characters long.')).toBeTruthy());
    expect(screen.getByRole('textbox', { name: 'Topic' })).toHaveValue('Refused');
  });

  it('shows the topic read-only without MANAGE_CHANNELS', () => {
    const view = bits(PermissionBits.VIEW_CHANNEL);
    seed(view, view);
    useSpaceStore.setState({ channels: [{ ...channel, topic: 'Read me' }] });
    render(<ChannelSettingsModal />);
    expect(screen.queryByRole('textbox', { name: 'Topic' })).toBeNull();
    expect(screen.getByText('Read me')).toBeTruthy();
  });

  it('offers no topic field for a voice channel', () => {
    seed(manage, manage);
    useSpaceStore.setState({ channels: [{ ...channel, type: 'voice' }] });
    render(<ChannelSettingsModal />);
    expect(screen.queryByRole('textbox', { name: 'Topic' })).toBeNull();
  });
});
