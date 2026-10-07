import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DmChannel, MessageWithUser, User } from '@backspace/shared';

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

// By default the send never answers: most tests read the optimistic rows it
// leaves. A test that needs the request to settle overrides `send` once.
const { send } = vi.hoisted(() => ({
  send: vi.fn((): Promise<void> => new Promise<never>(() => {})),
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
import { isMe, useAuthStore } from './authStore';
import { findLastOwnEditableMessage } from '../components/chat/messageEditing';
import { formatDmSidebarPreview } from '../utils/dmFormatters';
import { selfIdentityOf, userKey } from '../utils/identity';

// The account is native to the page's instance (nova, origin ''); orbit
// knows the same person as row o-7, and orbit's own user o-1 shares the id
// the session row has on nova.
const ORBIT = 'https://orbit.example';
const CHANNEL = 'orbit-chan';
const DM = 'orbit-dm';

const me = { id: 'n-1', username: 'jannis', displayName: 'Jannis', avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;
const orbitMira = { id: 'n-1', username: 'mira', displayName: 'Mira', avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;
const orbitMe = { ...me, id: 'o-7', username: 'jannis@localhost:3000', homeInstance: 'localhost:3000', homeUserId: 'n-1' } as User;

function cached(channelId: string): MessageWithUser[] {
  return useChatStore.getState().messages.get(channelId) ?? [];
}

function serverMessage(id: string, user: User, createdAt: number): MessageWithUser {
  return {
    id, channelId: CHANNEL, userId: user.id, replyToId: null, content: `message ${id}`,
    editedAt: null, createdAt, user, attachments: [], embeds: [], reactions: [],
  };
}

beforeEach(() => {
  useAuthStore.setState({ user: me, myRowIds: new Map([[ORBIT, 'o-7']]) });
  useSpaceStore.setState({
    spaceChannelIndex: new Map([[CHANNEL, 'orbit-space']]),
    channelOriginMap: new Map([[CHANNEL, ORBIT], [DM, ORBIT]]),
    dmChannels: [],
  });
  useChatStore.setState({ messages: new Map(), replyTargets: new Map(), detachedChannels: new Map() });
});

afterEach(() => {
  send.mockClear();
  useChatStore.setState({ messages: new Map() });
  useSpaceStore.setState({ spaceChannelIndex: new Map(), channelOriginMap: new Map(), dmChannels: [] });
  useAuthStore.setState({ user: null, myRowIds: new Map() });
});

describe('sendMessage optimistic rows on another instance', () => {
  it("authors the unsent message as the channel's instance knows the user", () => {
    void useChatStore.getState().sendMessage(CHANNEL, 'hello orbit');
    const [temp] = cached(CHANNEL);
    expect(temp!.id.startsWith('temp_')).toBe(true);
    expect(temp!.userId).toBe('o-7');
    expect(temp!.user.id).toBe('o-7');
    expect(isMe(temp!.user, ORBIT)).toBe(true);
    expect(userKey(temp!.user, ORBIT)).toBe(userKey(me, ''));
  });

  it('keeps Up arrow from opening an older message while the newest is unsent', () => {
    useChatStore.setState({ messages: new Map([[CHANNEL, [serverMessage('1', orbitMe, 1)]]]) });
    void useChatStore.getState().sendMessage(CHANNEL, 'just sent');
    const self = selfIdentityOf(me, useAuthStore.getState().myRowIds);
    expect(findLastOwnEditableMessage(cached(CHANNEL), ORBIT, self)).toBeNull();
  });

  it("does not make the user out to be orbit's own user who shares the session row's id", () => {
    void useChatStore.getState().sendMessage(CHANNEL, 'hello');
    const [temp] = cached(CHANNEL);
    expect(userKey(temp!.user, ORBIT)).not.toBe(userKey(orbitMira, ORBIT));
  });

  it("previews the unsent group DM message as the user's", () => {
    const dm = {
      id: DM, ownerId: 'o-2', name: null, icon: null, createdAt: 1,
      members: [orbitMe, { ...orbitMira, id: 'o-2' }],
      lastMessage: null,
    } as unknown as DmChannel;
    let patched: DmChannel | null = null;
    useSpaceStore.setState({
      dmChannels: [dm],
      patchDmCopy: (_id: string, patch: (channel: DmChannel) => DmChannel) => { patched = patch(dm); },
    });
    void useChatStore.getState().sendMessage(DM, 'hi all');
    expect(patched!.lastMessage!.userId).toBe('o-7');
    const viewer = { self: selfIdentityOf(me, useAuthStore.getState().myRowIds), origin: ORBIT };
    expect(formatDmSidebarPreview(patched!, viewer)).toBe('hi all');
  });

  it("makes no optimistic row while the channel's instance has not named the user's row", () => {
    useAuthStore.setState({ myRowIds: new Map() });
    void useChatStore.getState().sendMessage(CHANNEL, 'early');
    expect(cached(CHANNEL)).toEqual([]);
  });
});

describe('sendMessage optimistic rows on the page instance', () => {
  it('authors the unsent message with the session row', () => {
    useSpaceStore.setState({ channelOriginMap: new Map([[CHANNEL, '']]) });
    void useChatStore.getState().sendMessage(CHANNEL, 'hello nova');
    const [temp] = cached(CHANNEL);
    expect(temp!.userId).toBe('n-1');
    expect(temp!.user).toBe(me);
  });
});

describe('sendMessage when the request fails', () => {
  it('removes the optimistic message and rejects so the composer can keep the text', async () => {
    send.mockRejectedValueOnce(new Error('Offline'));
    await expect(useChatStore.getState().sendMessage(CHANNEL, 'hello')).rejects.toThrow('Offline');
    expect(cached(CHANNEL)).toEqual([]);
  });

  it('resolves once the request is accepted, leaving the optimistic message for its event to replace', async () => {
    send.mockResolvedValueOnce(undefined);
    await expect(useChatStore.getState().sendMessage(CHANNEL, 'hello')).resolves.toBeUndefined();
    expect(cached(CHANNEL).map((m) => m.content)).toEqual(['hello']);
  });
});
