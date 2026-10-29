import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useBookmarkStore } from '../../stores/bookmarkStore';
import { useChatStore } from '../../stores/chatStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';
import { Message } from './Message';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn(() => true), wsSendAll: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

const add = vi.fn();
const remove = vi.fn();
vi.mock('../../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({ bookmarks: { add: (...args: unknown[]) => add(...args), remove: (...args: unknown[]) => remove(...args) } }),
}));

const ORIGIN = 'https://home.test';

function makeUser(id: string, username: string): User {
  return {
    id, username, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

const me = makeUser('me', 'alice');
const bob = makeUser('bob', 'bob');
const dm = { id: 'dm-1', ownerId: 'me', name: null, createdAt: 1, members: [me, bob], lastMessage: null } as unknown as DmChannel;

const message = {
  id: 'm-1', channelId: '', dmChannelId: dm.id, userId: bob.id, replyToId: null, content: 'hello', editedAt: null,
  createdAt: 1, user: bob, attachments: [], embeds: [], reactions: [],
} as MessageWithUser;

function saved() {
  return {
    id: 'b-1', kind: 'dm' as const, messageId: message.id, channelId: dm.id, spaceId: null, content: 'hello', authorId: bob.id,
    authorName: 'bob', spaceName: null, channelName: 'bob', instanceOrigin: ORIGIN, messageCreatedAt: 1, createdAt: 2,
    attachments: [], status: 'ok' as const,
  };
}

function renderMessage(over: Partial<MessageWithUser> = {}): void {
  render(
    <>
      <Message message={{ ...message, ...over }} isCompact={false} isFirstInGroup previousMessageId={null} />
      <ContextMenuRenderer />
    </>,
  );
  fireEvent.mouseEnter(document.getElementById(`msg-${message.id}`)!);
}

beforeEach(() => {
  add.mockReset();
  remove.mockReset();
  useAuthStore.setState({ user: me, myRowIds: new Map() });
  useSpaceStore.setState({ dmChannels: [dm], channelOriginMap: new Map([[dm.id, ORIGIN]]) });
  useChatStore.setState({ messages: new Map([[dm.id, [message]]]), detachedChannels: new Map() });
  useUIStore.setState({ isMobile: false });
});

afterEach(() => {
  act(() => useContextMenuStore.getState().close());
  useBookmarkStore.getState().reset();
  useAuthStore.setState({ user: null, myRowIds: new Map() });
  useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map() });
  useChatStore.setState({ messages: new Map() });
});

describe('a bookmark on a message', () => {
  it('saves the message from the hover bar and then shows the button as pressed', async () => {
    add.mockResolvedValue(saved());
    renderMessage();
    const button = screen.getByRole('button', { name: 'Bookmark' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove bookmark' })).toHaveAttribute('aria-pressed', 'true'));
    expect(add).toHaveBeenCalledWith('dm', message.id);
  });

  it('removes the bookmark from the hover bar', async () => {
    useBookmarkStore.getState().applyAdded(ORIGIN, saved());
    remove.mockResolvedValue({ success: true });
    renderMessage();
    fireEvent.click(screen.getByRole('button', { name: 'Remove bookmark' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bookmark' })).toBeInTheDocument());
    expect(remove).toHaveBeenCalledWith('dm', message.id);
  });

  it('offers the same action in the context menu', async () => {
    add.mockResolvedValue(saved());
    renderMessage();
    fireEvent.contextMenu(document.getElementById(`msg-${message.id}`)!);
    fireEvent.click(screen.getByText('Bookmark message'));
    await waitFor(() => expect(add).toHaveBeenCalledWith('dm', message.id));
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it('has no bookmark button on a system message', () => {
    renderMessage({ type: 'system' });
    expect(screen.queryByRole('button', { name: 'Bookmark' })).toBeNull();
    fireEvent.contextMenu(document.getElementById(`msg-${message.id}`)!);
    expect(screen.queryByText('Bookmark message')).toBeNull();
  });

  it('is offered on the page\'s own instance, whose origin is the empty string', async () => {
    useSpaceStore.setState({ channelOriginMap: new Map([[dm.id, '']]) });
    add.mockResolvedValue({ ...saved(), instanceOrigin: '' });
    renderMessage();
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove bookmark' })).toBeInTheDocument());
  });

  it('has none while the message\'s instance is not known', () => {
    useSpaceStore.setState({ channelOriginMap: new Map() });
    renderMessage();
    expect(screen.queryByRole('button', { name: 'Bookmark' })).toBeNull();
  });
});
