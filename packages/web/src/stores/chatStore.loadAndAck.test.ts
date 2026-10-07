import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MessageWithUser, User } from '@backspace/shared';

const wsSend = vi.fn();
vi.mock('../hooks/useWebSocket', () => ({
  wsSend: (...args: unknown[]) => wsSend(...args),
  wsSendAll: vi.fn(),
}));

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

const channelsMessages = vi.fn();
vi.mock('../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    channels: {
      messages: (...args: unknown[]) => channelsMessages(...args),
      messagesAround: vi.fn(),
    },
  }),
}));

import { useChatStore } from './chatStore';
import { useSpaceStore } from './spaceStore';

const A = 'chan-a';
const B = 'chan-b';

const author = { id: 'u1', username: 'mira', displayName: null, avatar: null, createdAt: 1 } as unknown as User;

function msg(id: string, channelId = A): MessageWithUser {
  return {
    id,
    channelId,
    userId: 'u1',
    replyToId: null,
    content: `message ${id}`,
    editedAt: null,
    createdAt: Number(id),
    user: author,
    attachments: [],
    embeds: [],
    reactions: [],
  };
}

beforeEach(() => {
  wsSend.mockReset();
  channelsMessages.mockReset();
  useSpaceStore.setState({ channelOriginMap: new Map([[A, ''], [B, '']]), dmChannels: [] });
  useChatStore.setState({
    messages: new Map(),
    hasMore: new Map(),
    loadStates: new Map(),
    readStates: new Map(),
    unreadChannels: new Set(),
    detachedChannels: new Map(),
  });
});

describe('per-channel load state', () => {
  it('marks only the channel being loaded as loading', async () => {
    let resolve: (m: MessageWithUser[]) => void = () => {};
    channelsMessages.mockReturnValue(new Promise<MessageWithUser[]>((r) => { resolve = r; }));

    const load = useChatStore.getState().loadMessages(A);
    expect(useChatStore.getState().loadStates.get(A)).toEqual({ status: 'loading' });
    expect(useChatStore.getState().loadStates.has(B)).toBe(false);

    resolve([msg('1')]);
    await load;
    expect(useChatStore.getState().loadStates.has(A)).toBe(false);
  });

  it('keeps a failure on the channel that failed, with its error', async () => {
    const error = new Error('network down');
    channelsMessages.mockRejectedValue(error);

    expect(await useChatStore.getState().loadMessages(A)).toBe(false);

    expect(useChatStore.getState().loadStates.get(A)).toEqual({ status: 'failed', error });
    expect(useChatStore.getState().loadStates.has(B)).toBe(false);
  });

  it('waits on a channel no listing names, and loads it once one does', async () => {
    const unknown = 'chan-unknown';
    channelsMessages.mockResolvedValue([msg('1', unknown)]);

    expect(await useChatStore.getState().loadMessages(unknown)).toBe(false);
    expect(useChatStore.getState().loadStates.get(unknown)).toEqual({ status: 'waiting' });
    expect(channelsMessages).not.toHaveBeenCalled();

    useSpaceStore.setState({ channelOriginMap: new Map([[A, ''], [B, ''], [unknown, '']]) });
    const load = useChatStore.getState().loadMessages(unknown);
    expect(useChatStore.getState().loadStates.get(unknown)).toEqual({ status: 'loading' });
    expect(await load).toBe(true);
    expect(useChatStore.getState().loadStates.has(unknown)).toBe(false);
    expect(useChatStore.getState().messages.get(unknown)?.map((m) => m.id)).toEqual(['1']);
  });

  it('clears the failure when a retry succeeds', async () => {
    channelsMessages.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce([msg('1')]);

    await useChatStore.getState().loadMessages(A);
    expect(await useChatStore.getState().loadMessages(A, true)).toBe(true);

    expect(useChatStore.getState().loadStates.has(A)).toBe(false);
    expect(useChatStore.getState().messages.get(A)?.map((m) => m.id)).toEqual(['1']);
  });
});

describe('read states only move forward', () => {
  it('does not ack a detached window', () => {
    useChatStore.setState({
      messages: new Map([[A, [msg('100'), msg('101')]]]),
      detachedChannels: new Map([[A, []]]),
      readStates: new Map([[A, '90']]),
      unreadChannels: new Set([A]),
    });

    useChatStore.getState().ackChannel(A);

    expect(wsSend).not.toHaveBeenCalled();
    expect(useChatStore.getState().readStates.get(A)).toBe('90');
    expect(useChatStore.getState().unreadChannels.has(A)).toBe(true);
  });

  it('does not move the read position back when the cache ends before it', () => {
    useChatStore.setState({
      messages: new Map([[A, [msg('100'), msg('101')]]]),
      readStates: new Map([[A, '150']]),
    });

    useChatStore.getState().ackChannel(A);

    expect(useChatStore.getState().readStates.get(A)).toBe('150');
    expect(wsSend).not.toHaveBeenCalled();
  });

  it('acks the newest loaded message when it is past the read position', () => {
    useChatStore.setState({
      messages: new Map([[A, [msg('100'), msg('101')]]]),
      readStates: new Map([[A, '90']]),
      unreadChannels: new Set([A]),
    });

    useChatStore.getState().ackChannel(A);

    expect(wsSend).toHaveBeenCalledWith({ type: 'channel_ack', channelId: A, messageId: '101' }, '');
    expect(useChatStore.getState().readStates.get(A)).toBe('101');
    expect(useChatStore.getState().unreadChannels.has(A)).toBe(false);
  });

  it('ignores an ack echo older than the read position', () => {
    useChatStore.setState({ readStates: new Map([[A, '150']]), unreadChannels: new Set() });

    useChatStore.getState().onChannelAck(A, '120');

    expect(useChatStore.getState().readStates.get(A)).toBe('150');
  });

  it('takes a newer ack from another session', () => {
    useChatStore.setState({ readStates: new Map([[A, '150']]), unreadChannels: new Set([A]) });

    useChatStore.getState().onChannelAck(A, '160');

    expect(useChatStore.getState().readStates.get(A)).toBe('160');
    expect(useChatStore.getState().unreadChannels.has(A)).toBe(false);
  });
});
