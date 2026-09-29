import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Channel, DmChannel, SpaceWithChannelsAndMembers, User } from '@backspace/shared';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn(), wsSendAll: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

const dmMessages = vi.fn();
const channelMessages = vi.fn();
vi.mock('../../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    dm: { messages: (...args: unknown[]) => dmMessages(...args) },
    channels: { messages: (...args: unknown[]) => channelMessages(...args) },
  }),
}));

import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import i18n from '../../i18n';

// Before the `ready` that lists a channel, the client does not know whether
// it is a DM. The list waits instead of refusing; the composer stays locked;
// both follow the listing when it arrives, whatever the URL says.

const me = { id: 'me', username: 'alice', displayName: 'Alice', avatar: null, createdAt: 1 } as unknown as User;
const kai = { id: 'kai', username: 'kai', displayName: 'Kai', avatar: null, createdAt: 1 } as unknown as User;
const DM: DmChannel = { id: 'dm-1', federatedId: null, createdAt: 1, members: [me, kai] } as DmChannel;

function textChannel(id: string, myPermissions: string): Channel {
  return { id, spaceId: 's1', name: id, type: 'text', topic: null, position: 0, categoryId: null, createdAt: 1, myPermissions };
}

function space(channels: Channel[]): SpaceWithChannelsAndMembers {
  return {
    id: 's1', name: 's1', icon: null, banner: null, avatarColor: null, ownerId: 'o', inviteCode: null,
    visibility: 'private', directoryListed: false, description: null, createdAt: 1,
    channels, categories: [], members: [], roles: [], myPermissions: '0',
  };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  dmMessages.mockReset().mockResolvedValue([]);
  channelMessages.mockReset().mockResolvedValue([]);
  useSpaceStore.getState().reset();
  useAuthStore.setState({ user: me });
  useUIStore.setState({ isMobile: false });
  useComposerStore.setState({ states: new Map() });
  window.history.replaceState(null, '', '/channels/@me/dm-1');
});

afterEach(() => {
  useChatStore.getState().clearAllMessages();
  useChatStore.setState({ hasMore: new Map() });
  useSpaceStore.getState().reset();
  useAuthStore.setState({ user: null });
  window.history.replaceState(null, '', '/');
});

describe('MessageList while the channel is unknown', () => {
  it('does not claim a missing permission, and loads once the listing names the DM', async () => {
    render(<MemoryRouter><MessageList channelId={DM.id} /></MemoryRouter>);

    expect(screen.queryByText(i18n.t('chat:list.noHistoryPermission'))).not.toBeInTheDocument();
    expect(dmMessages).not.toHaveBeenCalled();
    expect(channelMessages).not.toHaveBeenCalled();

    await act(async () => { useSpaceStore.getState().populateFromReady('', [], [], [DM]); });
    await act(async () => { await useChatStore.getState().loadMessages(DM.id, true); });

    expect(dmMessages).toHaveBeenCalledWith(DM.id);
    expect(channelMessages).not.toHaveBeenCalled();
  });

  it('refuses a known space channel without READ_MESSAGE_HISTORY on the DM route', () => {
    useSpaceStore.getState().populateFromReady('', [space([textChannel('c1', '0')])], [], []);
    window.history.replaceState(null, '', '/channels/@me/c1');

    render(<MemoryRouter><MessageList channelId="c1" /></MemoryRouter>);

    expect(screen.getByText(i18n.t('chat:list.noHistoryPermission'))).toBeInTheDocument();
  });
});

describe('MessageInput while the channel is unknown', () => {
  it('stays locked, then opens when the listing names the DM', () => {
    render(<MessageInput channelId={DM.id} channelName="@Kai" />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // Locked, but not for a missing permission: nothing is known yet.
    expect(screen.queryByText(i18n.t('chat:composer.noPermission'))).not.toBeInTheDocument();

    act(() => { useSpaceStore.getState().populateFromReady('', [], [], [DM]); });

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('a known space channel without SEND_MESSAGES stays locked on the DM route', () => {
    useSpaceStore.getState().populateFromReady('', [space([textChannel('c1', '0')])], [], []);
    render(<MessageInput channelId="c1" channelName="#c1" />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('chat:composer.noPermission'))).toBeInTheDocument();
  });
});
