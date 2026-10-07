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

const channelsMessages = vi.fn();
const channelsMessagesAfter = vi.fn();
const channelsSendMessage = vi.fn();
const requestedOrigins: string[] = [];
vi.mock('../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/crossStoreResolvers')>()),
  getApiForOrigin: (origin: string) => {
    requestedOrigins.push(origin);
    return {
      channels: {
        messages: (...args: unknown[]) => channelsMessages(...args),
        messagesAfter: (...args: unknown[]) => channelsMessagesAfter(...args),
        messagesAround: vi.fn(),
        sendMessage: (...args: unknown[]) => channelsSendMessage(...args),
      },
    };
  },
}));

import { useChatStore } from './chatStore';
import { useSpaceStore } from './spaceStore';
import { useAuthStore } from './authStore';

const CHANNEL = 'chan-1';
const ORIGIN = 'https://orbit.example';

const author = { id: 'u1', username: 'mira', displayName: null, avatar: null, createdAt: 1 } as unknown as User;

function msg(id: string, extra: Partial<MessageWithUser> = {}): MessageWithUser {
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
    ...extra,
  };
}

function range(from: number, to: number): MessageWithUser[] {
  const out: MessageWithUser[] = [];
  for (let i = from; i <= to; i++) out.push(msg(String(i)));
  return out;
}

function cachedIds(): string[] {
  return (useChatStore.getState().messages.get(CHANNEL) ?? []).map((m) => m.id);
}

function isDetached(): boolean {
  return useChatStore.getState().detachedChannels.has(CHANNEL);
}

/** A detached window of ids 100-149 with nothing held yet. */
function detachedWindow(messages: MessageWithUser[] = range(100, 149)): void {
  useChatStore.setState({
    messages: new Map([[CHANNEL, messages]]),
    hasMore: new Map([[CHANNEL, true]]),
    detachedChannels: new Map([[CHANNEL, []]]),
  });
}

beforeEach(() => {
  channelsMessages.mockReset();
  channelsMessagesAfter.mockReset();
  channelsSendMessage.mockReset();
  requestedOrigins.length = 0;
  useSpaceStore.setState({ channelOriginMap: new Map([[CHANNEL, ORIGIN]]), dmChannels: [] });
  useChatStore.setState({
    messages: new Map(),
    hasMore: new Map(),
    channelAccessTimes: new Map(),
    detachedChannels: new Map(),
    presentReturns: new Map(),
    realtimeMessageEvents: [],
    replyTo: null,
  });
});

describe('chatStore.loadNewerMessages', () => {
  it("asks the channel's origin for the page after the window's greatest id and appends it", async () => {
    detachedWindow();
    channelsMessagesAfter.mockResolvedValue({ messages: range(150, 199), forward: true });

    expect(await useChatStore.getState().loadNewerMessages(CHANNEL)).toBe('paged');

    expect(requestedOrigins).toContain(ORIGIN);
    expect(channelsMessagesAfter).toHaveBeenCalledWith(CHANNEL, '149', 50);
    expect(cachedIds()).toEqual(range(100, 199).map((m) => m.id));
    expect(isDetached()).toBe(true);
  });

  it('cuts at the greatest id, not at the last row', async () => {
    // A relayed message keeps its sender's createdAt but carries a later
    // local id, so it is not the last row.
    detachedWindow([msg('100'), msg('160', { createdAt: 101 }), msg('120')]);
    channelsMessagesAfter.mockResolvedValue({ messages: [], forward: true });

    await useChatStore.getState().loadNewerMessages(CHANNEL);

    expect(channelsMessagesAfter).toHaveBeenCalledWith(CHANNEL, '160', 50);
  });

  it('attaches the window when a page is shorter than the limit', async () => {
    detachedWindow();
    channelsMessagesAfter.mockResolvedValue({ messages: range(150, 160), forward: true });

    expect(await useChatStore.getState().loadNewerMessages(CHANNEL)).toBe('attached');

    expect(cachedIds().at(-1)).toBe('160');
    expect(isDetached()).toBe(false);
  });

  it('attaches the window on an empty page: nothing is newer', async () => {
    detachedWindow();
    channelsMessagesAfter.mockResolvedValue({ messages: [], forward: true });

    expect(await useChatStore.getState().loadNewerMessages(CHANNEL)).toBe('attached');
    expect(isDetached()).toBe(false);
  });

  it('adds the live messages held while detached that the last page does not reach', async () => {
    detachedWindow();
    // 155 arrived while the page was on its way; 170 after the server cut it.
    useChatStore.getState().addRealtimeMessage(CHANNEL, msg('155'));
    useChatStore.getState().addRealtimeMessage(CHANNEL, msg('170'));
    expect(cachedIds().at(-1)).toBe('149');
    channelsMessagesAfter.mockResolvedValue({ messages: range(150, 160), forward: true });

    await useChatStore.getState().loadNewerMessages(CHANNEL);

    expect(cachedIds().slice(-3)).toEqual(['159', '160', '170']);
    expect(cachedIds().filter((id) => id === '155')).toHaveLength(1);
  });

  it('drops a page whose window was replaced while it loaded', async () => {
    detachedWindow();
    let resolve: (page: { messages: MessageWithUser[]; forward: boolean }) => void = () => {};
    channelsMessagesAfter.mockReturnValue(new Promise((r) => { resolve = r; }));
    const loading = useChatStore.getState().loadNewerMessages(CHANNEL);

    // Another jump replaced the window meanwhile.
    useChatStore.setState({ messages: new Map([[CHANNEL, range(10, 59)]]) });
    resolve({ messages: range(150, 199), forward: true });

    expect(await loading).toBe('skipped');
    expect(cachedIds()).toEqual(range(10, 59).map((m) => m.id));
  });

  it('replaces the window with the newest page when the origin ignores the cursor', async () => {
    detachedWindow();
    useChatStore.getState().addRealtimeMessage(CHANNEL, msg('400'));
    channelsMessagesAfter.mockResolvedValue({ messages: range(350, 399), forward: false });

    expect(await useChatStore.getState().loadNewerMessages(CHANNEL)).toBe('present');

    expect(cachedIds()).toEqual([...range(350, 399).map((m) => m.id), '400']);
    expect(isDetached()).toBe(false);
    expect(useChatStore.getState().hasMore.get(CHANNEL)).toBe(true);
    expect(useChatStore.getState().presentReturns.get(CHANNEL)).toBe(1);
  });

  it('does nothing for an attached channel', async () => {
    useChatStore.setState({ messages: new Map([[CHANNEL, range(100, 149)]]) });

    expect(await useChatStore.getState().loadNewerMessages(CHANNEL)).toBe('skipped');
    expect(channelsMessagesAfter).not.toHaveBeenCalled();
  });
});

describe('live messages on a detached window', () => {
  it('are held, not appended, and still reach notifications', () => {
    detachedWindow();

    useChatStore.getState().addRealtimeMessage(CHANNEL, msg('300'));

    expect(cachedIds().at(-1)).toBe('149');
    expect(useChatStore.getState().detachedChannels.get(CHANNEL)?.map((m) => m.id)).toEqual(['300']);
    expect(useChatStore.getState().realtimeMessageEvents.map((e) => e.message.id)).toEqual(['300']);
  });

  it('follow edits and deletions while held', () => {
    detachedWindow();
    useChatStore.getState().addRealtimeMessage(CHANNEL, msg('300'));
    useChatStore.getState().addRealtimeMessage(CHANNEL, msg('301'));

    useChatStore.getState().updateMessage({ ...msg('300'), content: 'edited' });
    useChatStore.getState().removeMessage('301', CHANNEL);

    expect(useChatStore.getState().detachedChannels.get(CHANNEL)?.map((m) => [m.id, m.content])).toEqual([['300', 'edited']]);
  });

  it('join the newest page when the channel returns to the present', async () => {
    detachedWindow();
    useChatStore.getState().addRealtimeMessage(CHANNEL, msg('400'));
    channelsMessages.mockResolvedValue(range(350, 399));

    await useChatStore.getState().loadMessages(CHANNEL, true);

    expect(cachedIds().at(-1)).toBe('400');
    expect(isDetached()).toBe(false);
  });
});

describe('sending from a detached window', () => {
  it('returns the channel to the present and keeps the message being sent', async () => {
    useAuthStore.setState({ user: author });
    detachedWindow();
    let resolveNewest: (page: MessageWithUser[]) => void = () => {};
    channelsMessages.mockReturnValue(new Promise((r) => { resolveNewest = r; }));
    channelsSendMessage.mockReturnValue(new Promise(() => {}));

    void useChatStore.getState().sendMessage(CHANNEL, 'hello from the past');
    await Promise.resolve();
    resolveNewest(range(350, 399));
    await vi.waitFor(() => expect(isDetached()).toBe(false));

    const ids = cachedIds();
    expect(ids.slice(0, 50)).toEqual(range(350, 399).map((m) => m.id));
    expect(ids).toHaveLength(51);
    expect(ids[50]).toMatch(/^temp_/);
    expect(useChatStore.getState().presentReturns.get(CHANNEL)).toBe(1);
  });
});
