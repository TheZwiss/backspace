import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MessageWithUser, Reaction, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';
import { Message } from './Message';

// An open socket: every send is taken.
vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn(() => true), wsSendAll: vi.fn() }));
// The picker as a single choice: picking 👍.
vi.mock('./EmojiPicker', () => ({
  EmojiPicker: ({ onEmojiSelect }: { onEmojiSelect: (emoji: { native: string }) => void }) => (
    <button type="button" data-testid="emoji-picker" onClick={() => onEmojiSelect({ native: '👍' })}>pick</button>
  ),
}));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { wsSend } from '../../hooks/useWebSocket';

/**
 * #393, the menu path: a reaction picked in the message menu (the long-press
 * sheet on mobile, the right-click menu on desktop) closes the menu, as the
 * emoji picker does, and is never sent as a second add for a reaction the
 * user already holds. The menu's "+" opens the picker, also on mobile where
 * the message has no hover bar to hang it off.
 */

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

const message: MessageWithUser = {
  id: 'm-1',
  channelId: '',
  dmChannelId: dm.id,
  userId: bob.id,
  replyToId: null,
  content: 'hello',
  editedAt: null,
  createdAt: 1,
  user: bob,
  attachments: [],
  embeds: [],
  reactions: [],
} as MessageWithUser;

function ownReaction(): Reaction {
  return { id: 'r-1', messageId: message.id, userId: me.id, emoji: '👍', createdAt: 2, user: me };
}

function sent(type: 'reaction_add' | 'reaction_remove'): unknown[] {
  return vi.mocked(wsSend).mock.calls.filter(([event]) => (event as { type: string }).type === type);
}

function openMenu(): void {
  fireEvent.contextMenu(document.getElementById(`msg-${message.id}`)!);
}

function renderMessage(): void {
  render(
    <>
      <Message message={message} isCompact={false} isFirstInGroup previousMessageId={null} />
      <ContextMenuRenderer />
    </>,
  );
}

beforeEach(() => {
  vi.mocked(wsSend).mockClear();
  useAuthStore.setState({ user: me, myRowIds: new Map() });
  useSpaceStore.setState({ dmChannels: [dm], channelOriginMap: new Map([[dm.id, '']]) });
  useChatStore.setState({ messages: new Map([[dm.id, [message]]]), detachedChannels: new Map(), reactionAddsInFlight: new Map() });
});

afterEach(() => {
  act(() => useContextMenuStore.getState().close());
  useUIStore.setState({ isMobile: false });
  useAuthStore.setState({ user: null, myRowIds: new Map() });
  useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map() });
  useChatStore.setState({ messages: new Map(), reactionAddsInFlight: new Map() });
});

describe.each([
  ['the mobile long-press sheet', true],
  ['the desktop context menu', false],
])('a quick reaction in %s', (_label, isMobile) => {
  beforeEach(() => {
    useUIStore.setState({ isMobile });
  });

  it('sends one add and closes the menu', () => {
    renderMessage();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: '👍' }));

    expect(sent('reaction_add')).toEqual([[{ type: 'reaction_add', messageId: message.id, emoji: '👍' }, '']]);
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it('sends nothing for a second tap while the add is in flight, neither an add nor a remove', () => {
    renderMessage();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: '👍' }));
    // No answer yet: no pill shows the reaction, so the second tap is an add.
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: '👍' }));

    expect(sent('reaction_add')).toHaveLength(1);
    expect(sent('reaction_remove')).toEqual([]);
  });

  it('reads the reactions the store holds when tapped, not the ones it held when the menu opened', () => {
    renderMessage();
    openMenu();
    // The user's reaction arrives while the menu is open (added from another
    // device, say); the menu's items were built before it.
    act(() => useChatStore.getState().onReactionAdded(message.id, ownReaction()));
    fireEvent.click(screen.getByRole('button', { name: '👍' }));

    expect(sent('reaction_add')).toEqual([]);
    expect(sent('reaction_remove')).toHaveLength(1);
  });
});

describe.each([
  ['the mobile long-press sheet', true],
  ['the desktop context menu', false],
])('the "+" in %s', (_label, isMobile) => {
  beforeEach(() => {
    useUIStore.setState({ isMobile });
  });

  function openPickerFromMenu(): void {
    openMenu();
    const plus = screen.getAllByRole('button').find(b => b.getAttribute('title') === 'Add reaction');
    fireEvent.click(plus!);
  }

  it('closes the menu and opens the picker', () => {
    renderMessage();
    openPickerFromMenu();
    expect(useContextMenuStore.getState().menu).toBeNull();
    expect(screen.getByTestId('emoji-picker')).toBeTruthy();
  });

  it('sends one add for a picked emoji and closes the picker', () => {
    renderMessage();
    openPickerFromMenu();
    fireEvent.click(screen.getByTestId('emoji-picker'));
    expect(sent('reaction_add')).toHaveLength(1);
    expect(screen.queryByTestId('emoji-picker')).toBeNull();
  });

  it('sends nothing for an emoji the user already reacted with, and closes the picker', () => {
    useChatStore.setState({ messages: new Map([[dm.id, [{ ...message, reactions: [ownReaction()] }]]]) });
    renderMessage();
    openPickerFromMenu();
    fireEvent.click(screen.getByTestId('emoji-picker'));
    expect(sent('reaction_add')).toEqual([]);
    expect(screen.queryByTestId('emoji-picker')).toBeNull();
  });
});

describe('a quick reaction in the desktop hover bar', () => {
  function quick(emoji: string): HTMLElement {
    fireEvent.mouseEnter(document.getElementById(`msg-${message.id}`)!);
    return screen.getByRole('button', { name: emoji });
  }

  it('sends one add for a double click, and no remove', () => {
    renderMessage();
    fireEvent.click(quick('👍'));
    fireEvent.click(quick('👍'));
    expect(sent('reaction_add')).toHaveLength(1);
    expect(sent('reaction_remove')).toEqual([]);
  });

  it('removes the reaction once the answer has stored it', () => {
    renderMessage();
    fireEvent.click(quick('👍'));
    act(() => useChatStore.getState().onReactionAdded(message.id, ownReaction()));
    fireEvent.click(quick('👍'));
    expect(sent('reaction_add')).toHaveLength(1);
    expect(sent('reaction_remove')).toHaveLength(1);
  });
});

describe('the "+" in the desktop hover bar', () => {
  it('opens the picker and closes it again', () => {
    renderMessage();
    fireEvent.mouseEnter(document.getElementById(`msg-${message.id}`)!);
    const plus = () => screen.getAllByRole('button').find(b => b.getAttribute('title') === 'Add reaction')!;
    fireEvent.click(plus());
    expect(screen.getByTestId('emoji-picker')).toBeTruthy();
    fireEvent.click(plus());
    expect(screen.queryByTestId('emoji-picker')).toBeNull();
  });
});
