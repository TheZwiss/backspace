import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { Message } from './Message';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn(() => true), wsSendAll: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

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

const row = (): HTMLElement => document.getElementById(`msg-${message.id}`)!;
const actionBar = (): HTMLElement | null => document.querySelector('[data-side="top"]');

beforeEach(() => {
  useAuthStore.setState({ user: me, myRowIds: new Map() });
  useSpaceStore.setState({ dmChannels: [dm], channelOriginMap: new Map([[dm.id, 'https://home.test']]) });
  useChatStore.setState({ messages: new Map([[dm.id, [message]]]), detachedChannels: new Map() });
  useUIStore.setState({ isMobile: false });
  render(<Message message={message} isCompact={false} isFirstInGroup previousMessageId={null} />);
});

afterEach(() => {
  useAuthStore.setState({ user: null, myRowIds: new Map() });
  useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map() });
  useUIStore.setState({ isMobile: false });
});

describe('action bar on a touch screen', () => {
  it('shows with a real mouse', () => {
    fireEvent.mouseEnter(row());
    expect(actionBar()).not.toBeNull();
  });

  it('does not appear from the mouse events a tap leaves behind', () => {
    // A tap is a touch pointer followed by compatibility mouse events at the same point
    fireEvent.pointerDown(row(), { pointerType: 'touch' });
    fireEvent.mouseEnter(row());
    expect(actionBar()).toBeNull();
  });

  it('shows again once the touch is old news', () => {
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(row(), { pointerType: 'touch' });
      act(() => { vi.advanceTimersByTime(1500); });
      fireEvent.mouseEnter(row());
      expect(actionBar()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never shows in the mobile layout, where holding the message opens its menu', () => {
    act(() => useUIStore.setState({ isMobile: true }));
    fireEvent.mouseEnter(row());
    expect(actionBar()).toBeNull();
  });
});
