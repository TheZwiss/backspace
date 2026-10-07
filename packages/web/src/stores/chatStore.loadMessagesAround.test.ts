import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MessageWithUser, User } from '@backspace/shared';

vi.mock('../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
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

const channelsMessagesAround = vi.fn();
const channelsMessages = vi.fn();
const requestedOrigins: string[] = [];
vi.mock('../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/crossStoreResolvers')>()),
  getApiForOrigin: (origin: string) => {
    requestedOrigins.push(origin);
    return {
      channels: {
        messagesAround: (...args: unknown[]) => channelsMessagesAround(...args),
        messages: (...args: unknown[]) => channelsMessages(...args),
      },
    };
  },
}));

import { useChatStore } from './chatStore';
import { useSpaceStore } from './spaceStore';
import { HttpError } from '../api/client';

const CHANNEL = 'chan-1';
const ORIGIN = 'https://orbit.example';

const author = {
  id: 'u1',
  username: 'mira',
  displayName: null,
  avatar: null,
  createdAt: 1,
} as unknown as User;

function msg(id: string): MessageWithUser {
  return {
    id,
    channelId: CHANNEL,
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

/** Ids `from`..`to` inclusive, as zero-padded strings so they sort like snowflakes. */
function range(from: number, to: number): MessageWithUser[] {
  const out: MessageWithUser[] = [];
  for (let i = from; i <= to; i++) out.push(msg(String(i).padStart(4, '0')));
  return out;
}

beforeEach(() => {
  channelsMessagesAround.mockReset();
  channelsMessages.mockReset();
  requestedOrigins.length = 0;
  useSpaceStore.setState({ channelOriginMap: new Map([[CHANNEL, ORIGIN]]), dmChannels: [] });
  useChatStore.setState({
    messages: new Map([[CHANNEL, range(900, 949)]]),
    hasMore: new Map([[CHANNEL, true]]),
    channelAccessTimes: new Map(),
    scrollPositions: new Map(),
    detachedChannels: new Map(),
  });
});

describe('chatStore.loadMessagesAround', () => {
  it("asks the channel's origin and replaces the cache with the window", async () => {
    // 25 older + target + 25 newer: the server's full window, so newer
    // messages exist beyond it.
    channelsMessagesAround.mockResolvedValue(range(75, 125));

    const result = await useChatStore.getState().loadMessagesAround(CHANNEL, '0100');

    expect(result).toBe('loaded');
    expect(requestedOrigins).toContain(ORIGIN);
    expect(channelsMessagesAround).toHaveBeenCalledWith(CHANNEL, '0100', 50);
    expect(useChatStore.getState().messages.get(CHANNEL)?.map((m) => m.id)).toEqual(range(75, 125).map((m) => m.id));
  });

  it('marks the channel detached when the window stops short of the newest message', async () => {
    channelsMessagesAround.mockResolvedValue(range(75, 125));

    await useChatStore.getState().loadMessagesAround(CHANNEL, '0100');

    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(true);
  });

  it('does not mark the channel detached when the window reaches the newest message', async () => {
    // Only 10 messages after the target: the server ran out of newer rows.
    channelsMessagesAround.mockResolvedValue(range(75, 110));

    await useChatStore.getState().loadMessagesAround(CHANNEL, '0100');

    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(false);
  });

  it('reports not_found and keeps the cache when the target does not exist', async () => {
    channelsMessagesAround.mockRejectedValue(
      new HttpError(404, 'Message not found', undefined, 'message_not_found'),
    );
    const before = useChatStore.getState().messages.get(CHANNEL);

    const result = await useChatStore.getState().loadMessagesAround(CHANNEL, '0001');

    expect(result).toBe('not_found');
    expect(useChatStore.getState().messages.get(CHANNEL)).toBe(before);
    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(false);
  });

  it('reports failed on a network error', async () => {
    channelsMessagesAround.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await useChatStore.getState().loadMessagesAround(CHANNEL, '0001');

    expect(result).toBe('failed');
  });
});

describe('chatStore.loadMessages after a jump', () => {
  it('a forced reload returns the channel to the present', async () => {
    useChatStore.setState({ detachedChannels: new Map([[CHANNEL, []]]) });
    channelsMessages.mockResolvedValue(range(950, 999));

    await useChatStore.getState().loadMessages(CHANNEL, true);

    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(false);
    expect(useChatStore.getState().messages.get(CHANNEL)?.at(-1)?.id).toBe('0999');
  });
});
