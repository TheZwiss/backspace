import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

interface SendBody {
  content: string;
  attachments?: string[];
  replyToId?: string;
}

// The request the store sends, by default checked the way the server checks
// it: a reply must name a message in the channel it is posted into, or the
// route answers 400 `reply_target_invalid` (routes/messages.ts, routes/dm.ts).
const { send } = vi.hoisted(() => ({
  send: vi.fn<(channelId: string, body: SendBody) => Promise<void>>(),
}));
vi.mock('../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    channels: { sendMessage: send },
    dm: { sendMessage: send },
  }),
}));

import { useChatStore } from './chatStore';
import { useSpaceStore } from './spaceStore';
import { useAuthStore } from './authStore';
import { HttpError } from '../api/client';

const GENERAL = 'chan-general';
const RANDOM = 'chan-random';

const me = { id: 'u-1', username: 'jannis', displayName: 'Jannis', avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;
const mira = { id: 'u-2', username: 'mira', displayName: 'Mira', avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;

function message(id: string, channelId: string, user: User = mira): MessageWithUser {
  return {
    id, channelId, userId: user.id, replyToId: null, content: `message ${id}`,
    editedAt: null, createdAt: 1, user, attachments: [], embeds: [], reactions: [],
  };
}

function cached(channelId: string): MessageWithUser[] {
  return useChatStore.getState().messages.get(channelId) ?? [];
}

function replyTargetIn(channelId: string): MessageWithUser | undefined {
  return useChatStore.getState().replyTargets.get(channelId);
}

const replyTargetInvalid = (): HttpError =>
  new HttpError(400, 'Reply target not found in this channel', undefined, 'reply_target_invalid');

/** The server's rule: a reply target must be a message of the same channel. */
function serverChecksReplyTargets(): void {
  send.mockImplementation(async (channelId, body) => {
    if (!body.replyToId) return;
    const inChannel = cached(channelId).some((m) => m.id === body.replyToId);
    if (!inChannel) throw replyTargetInvalid();
  });
}

const inGeneral = message('100', GENERAL);
const inRandom = message('200', RANDOM);

beforeEach(() => {
  useAuthStore.setState({ user: me, myRowIds: new Map() });
  useSpaceStore.setState({
    spaceChannelIndex: new Map([[GENERAL, 'space-1'], [RANDOM, 'space-1']]),
    channelOriginMap: new Map([[GENERAL, ''], [RANDOM, '']]),
    dmChannels: [],
  });
  useChatStore.setState({
    messages: new Map([[GENERAL, [inGeneral]], [RANDOM, [inRandom]]]),
    replyTargets: new Map(),
    detachedChannels: new Map(),
  });
  serverChecksReplyTargets();
});

afterEach(() => {
  send.mockReset();
  useChatStore.getState().clearAllMessages();
  useSpaceStore.setState({ spaceChannelIndex: new Map(), channelOriginMap: new Map(), dmChannels: [] });
  useAuthStore.setState({ user: null, myRowIds: new Map() });
});

describe('reply state is scoped to its channel (#390)', () => {
  it('keeps a reply started in one channel out of every other channel', () => {
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);
    useChatStore.getState().setCurrentChannel(RANDOM);

    expect(replyTargetIn(RANDOM)).toBeUndefined();
    expect(replyTargetIn(GENERAL)).toBe(inGeneral);
  });

  it('sends a message in another channel without the reply, so it is not refused and rolled back', async () => {
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);
    useChatStore.getState().setCurrentChannel(RANDOM);

    await useChatStore.getState().sendMessage(RANDOM, 'hello random');

    expect(send).toHaveBeenCalledWith(RANDOM, expect.objectContaining({ replyToId: undefined }));
    const temp = cached(RANDOM).find((m) => m.id.startsWith('temp_'));
    expect(temp?.content).toBe('hello random');
    expect(temp?.replyToId).toBeNull();
    expect(temp?.replyTo).toBeUndefined();
    // The reply waits in its own channel.
    expect(replyTargetIn(GENERAL)).toBe(inGeneral);
  });

  it("sends the channel's own reply and consumes only that one", async () => {
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);
    useChatStore.getState().setReplyTo(RANDOM, inRandom);

    await useChatStore.getState().sendMessage(GENERAL, 'answer');

    expect(send).toHaveBeenCalledWith(GENERAL, expect.objectContaining({ replyToId: '100' }));
    const temp = cached(GENERAL).find((m) => m.id.startsWith('temp_'));
    expect(temp?.replyToId).toBe('100');
    expect(temp?.replyTo).toBe(inGeneral);
    expect(replyTargetIn(GENERAL)).toBeUndefined();
    expect(replyTargetIn(RANDOM)).toBe(inRandom);
  });

  it('cancels only the named channel', () => {
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);
    useChatStore.getState().setReplyTo(RANDOM, inRandom);

    useChatStore.getState().setReplyTo(GENERAL, null);

    expect(replyTargetIn(GENERAL)).toBeUndefined();
    expect(replyTargetIn(RANDOM)).toBe(inRandom);
  });
});

describe('a failed send and its reply', () => {
  it('gives the reply back to the composer when the request fails', async () => {
    send.mockRejectedValueOnce(new Error('Offline'));
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);

    await useChatStore.getState().sendMessage(GENERAL, 'answer');

    expect(cached(GENERAL).some((m) => m.id.startsWith('temp_'))).toBe(false);
    expect(replyTargetIn(GENERAL)).toBe(inGeneral);
  });

  it('does not replace a reply the user started while the request was pending', async () => {
    let fail!: (error: Error) => void;
    send.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const newer = message('101', GENERAL);
    useChatStore.setState({ messages: new Map([[GENERAL, [inGeneral, newer]], [RANDOM, [inRandom]]]) });
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);

    const sending = useChatStore.getState().sendMessage(GENERAL, 'answer');
    useChatStore.getState().setReplyTo(GENERAL, newer);
    fail(new Error('Offline'));
    await sending;

    expect(replyTargetIn(GENERAL)).toBe(newer);
  });

  it('drops the reply when the server refuses its target', async () => {
    send.mockRejectedValueOnce(replyTargetInvalid());
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);

    await useChatStore.getState().sendMessage(GENERAL, 'answer');

    expect(replyTargetIn(GENERAL)).toBeUndefined();
  });
});

describe('a reply to a removed message', () => {
  it('is cancelled when its target is deleted', () => {
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);

    useChatStore.getState().removeMessage('100', GENERAL);

    expect(replyTargetIn(GENERAL)).toBeUndefined();
  });

  it('is cancelled even when the channel is no longer cached', () => {
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);
    useChatStore.setState({ messages: new Map() });

    useChatStore.getState().removeMessage('100', GENERAL);

    expect(replyTargetIn(GENERAL)).toBeUndefined();
  });

  it('is kept when another message is removed', () => {
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);

    useChatStore.getState().removeMessage('999', GENERAL);

    expect(replyTargetIn(GENERAL)).toBe(inGeneral);
  });

  it('is cleared with the rest of the chat state', () => {
    useChatStore.getState().setReplyTo(GENERAL, inGeneral);

    useChatStore.getState().clearAllMessages();

    expect(useChatStore.getState().replyTargets.size).toBe(0);
  });
});
