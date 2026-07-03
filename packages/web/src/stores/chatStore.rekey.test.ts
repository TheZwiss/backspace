import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
  wsSendAll: vi.fn(),
}));

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Stub instanceStore to avoid initialization ordering issues
vi.mock('./instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ instances: [], _autoConnectDone: true }),
    {
      getState: () => ({ instances: [], _autoConnectDone: true }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

// Stub authStore to avoid localStorage access during module init
vi.mock('./authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, token: null }),
    {
      getState: () => ({ user: null, token: null }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

import { useChatStore } from './chatStore';
import type { MessageWithUser } from '@backspace/shared';

function msg(id: string): MessageWithUser {
  return {
    id,
    channelId: 'c',
    userId: 'u',
    content: 'hi',
    createdAt: 1,
    user: { id: 'u', username: 'u', displayName: null, avatar: null, homeInstance: null, homeUserId: null, accentColor: null, banner: null, bio: null, status: 'online', activities: [], createdAt: 1 } as any,
    attachments: [],
    embeds: [],
    reactions: [],
  };
}

beforeEach(() => {
  const s = useChatStore.getState();
  // Reset every map/set/scalar this test touches.
  useChatStore.setState({
    messages: new Map(),
    typingUsers: new Map(),
    hasMore: new Map(),
    readStates: new Map(),
    unreadChannels: new Set(),
    channelAccessTimes: new Map(),
    scrollPositions: new Map(),
    currentChannelId: null,
  });
  void s;
});

describe('chatStore.rekeyChannelState', () => {
  it('removes all channel-keyed state for oldId', () => {
    useChatStore.setState({
      messages: new Map([['A1', [msg('m1')]]]),
      typingUsers: new Map([['A1', [{ userId: 'u', username: 'u', timestamp: 1 }]]]),
      hasMore: new Map([['A1', true]]),
      readStates: new Map([['A1', 'msg-last']]),
      channelAccessTimes: new Map([['A1', 123]]),
      scrollPositions: new Map([['A1', 'msg-scroll']]),
    });

    useChatStore.getState().rekeyChannelState('A1', 'B1');

    const s = useChatStore.getState();
    expect(s.messages.has('A1')).toBe(false);
    expect(s.typingUsers.has('A1')).toBe(false);
    expect(s.hasMore.has('A1')).toBe(false);
    expect(s.readStates.has('A1')).toBe(false);
    expect(s.channelAccessTimes.has('A1')).toBe(false);
    expect(s.scrollPositions.has('A1')).toBe(false);
    // newId entries are NOT seeded for messages/hasMore/etc — they refetch naturally.
    expect(s.messages.has('B1')).toBe(false);
  });

  it('transfers unreadChannels membership only when oldId was unread', () => {
    useChatStore.setState({ unreadChannels: new Set(['A1']) });
    useChatStore.getState().rekeyChannelState('A1', 'B1');
    expect(useChatStore.getState().unreadChannels.has('A1')).toBe(false);
    expect(useChatStore.getState().unreadChannels.has('B1')).toBe(true);
  });

  it('does not add newId to unreadChannels if oldId was not unread', () => {
    useChatStore.setState({ unreadChannels: new Set(['other']) });
    useChatStore.getState().rekeyChannelState('A1', 'B1');
    expect(useChatStore.getState().unreadChannels.has('B1')).toBe(false);
    expect(useChatStore.getState().unreadChannels.has('other')).toBe(true);
  });

  it('updates currentChannelId when it matches oldId', () => {
    useChatStore.setState({ currentChannelId: 'A1' });
    useChatStore.getState().rekeyChannelState('A1', 'B1');
    expect(useChatStore.getState().currentChannelId).toBe('B1');
  });

  it('leaves currentChannelId alone when it does not match oldId', () => {
    useChatStore.setState({ currentChannelId: 'other' });
    useChatStore.getState().rekeyChannelState('A1', 'B1');
    expect(useChatStore.getState().currentChannelId).toBe('other');
  });

  it('no-ops cleanly when oldId is not present anywhere', () => {
    expect(() => useChatStore.getState().rekeyChannelState('missing', 'B1')).not.toThrow();
  });
});
