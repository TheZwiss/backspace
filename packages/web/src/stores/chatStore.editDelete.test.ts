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

const { updateMessage, deleteMessage } = vi.hoisted(() => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
}));
vi.mock('../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    dm: { updateMessage, deleteMessage },
    messages: { update: updateMessage, delete: deleteMessage },
  }),
}));

import { useChatStore } from './chatStore';
import { useSpaceStore } from './spaceStore';
import { useUIStore } from './uiStore';
import { HttpError } from '../api/client';
import i18n, { initI18n } from '../i18n';

// #420: an edit or delete the server refuses (a 1-on-1 whose partner was
// deleted answers recipient_deleted) is rolled back and the user is told
// why, in their language.

const DM = 'dm-dead';
const me = { id: 'u-1', username: 'jannis', displayName: null, avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;

// A DM message is keyed by its dmChannelId; channelId is empty.
const original = {
  id: 'm-1', channelId: '', dmChannelId: DM, userId: me.id, replyToId: null, content: 'before',
  editedAt: null, createdAt: 1, user: me, attachments: [], embeds: [], reactions: [],
} as MessageWithUser;

function refusal(): HttpError {
  return new HttpError(403, "This user's account was deleted", undefined, 'recipient_deleted');
}

function cached(): MessageWithUser[] {
  return useChatStore.getState().messages.get(DM) ?? [];
}

beforeEach(async () => {
  await initI18n();
  useSpaceStore.setState({
    dmChannels: [{ id: DM, federatedId: null, members: [], ownerId: null } as never],
    channelOriginMap: new Map(),
  });
  useChatStore.setState({ messages: new Map([[DM, [original]]]) });
  useUIStore.setState({ toasts: [] });
});

afterEach(() => {
  updateMessage.mockReset();
  deleteMessage.mockReset();
  useChatStore.setState({ messages: new Map() });
  useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map() });
});

describe('a refused DM edit', () => {
  it('restores the text and shows the reason', async () => {
    let reject: (err: unknown) => void = () => {};
    updateMessage.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));

    const editing = useChatStore.getState().editMessage('m-1', 'after', DM);
    expect(cached()[0]?.content).toBe('after');
    reject(refusal());
    await editing;

    expect(cached()[0]?.content).toBe('before');
    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe(i18n.t('errors:recipient_deleted'));
  });

  it('shows nothing when the edit goes through', async () => {
    updateMessage.mockResolvedValueOnce(undefined);

    await useChatStore.getState().editMessage('m-1', 'after', DM);

    expect(cached()[0]?.content).toBe('after');
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });
});

describe('a refused DM delete', () => {
  it('puts the message back and shows the reason', async () => {
    let reject: (err: unknown) => void = () => {};
    deleteMessage.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));

    const deleting = useChatStore.getState().deleteMessage('m-1', DM);
    expect(cached()).toHaveLength(0);
    reject(refusal());
    await deleting;

    expect(cached().map((m) => m.id)).toEqual(['m-1']);
    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe(i18n.t('errors:recipient_deleted'));
  });
});
