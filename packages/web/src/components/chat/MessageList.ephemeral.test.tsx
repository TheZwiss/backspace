import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EphemeralReply, MessageWithUser, User } from '@backspace/shared';

vi.mock('../../hooks/useWebSocket', () => ({
  wsSend: vi.fn(),
  wsSendAll: vi.fn(),
}));

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

const latestMessages = vi.fn();
vi.mock('../../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    channels: {
      messages: (...args: unknown[]) => latestMessages(...args),
      messagesAround: vi.fn(),
      messagesAfter: () => new Promise<never>(() => {}),
    },
  }),
}));

import { MessageList } from './MessageList';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useEphemeralReplyStore } from '../../stores/ephemeralReplyStore';
import { ALL_PERMISSIONS, permissionsToString } from '../../utils/permissions';

/** A bot's answer only the signed-in person sees, drawn in the timeline of its chat. */

const CHANNEL = 'chan-1';
const me = { id: 'u-1', username: 'jannis', displayName: 'Jannis', avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;
const mira = { id: 'u-2', username: 'mira', displayName: 'Mira', avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;
const bot = { id: 'b-1', username: 'mod_bot', displayName: 'Mod Bot', avatar: null, isBot: true, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;

const message = (id: string, content: string, createdAt: number): MessageWithUser => ({
  id, channelId: CHANNEL, userId: mira.id, replyToId: null, content,
  editedAt: null, createdAt, user: mira, attachments: [], embeds: [], reactions: [],
});
const first = message('m1', 'first from mira', 1_700_000_000_000);
const later = message('m2', 'later from mira', 1_700_000_060_000);
const answer: EphemeralReply = {
  id: 'e1', interactionId: 'i1', command: 'purge', user: bot, content: 'Purged 5 messages',
  createdAt: 1_700_000_030_000, channelId: CHANNEL, spaceId: 'space-1',
};

function renderList() {
  return render(
    <MemoryRouter>
      <MessageList channelId={CHANNEL} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  latestMessages.mockReset();
  latestMessages.mockResolvedValue([first, later]);
  useAuthStore.setState({ user: me, myRowIds: new Map() });
  useSpaceStore.setState({
    spaceChannelIndex: new Map([[CHANNEL, 'space-1']]),
    channelOriginMap: new Map([[CHANNEL, '']]),
    channelPermissions: new Map([[CHANNEL, permissionsToString(ALL_PERMISSIONS)]]),
    dmChannels: [],
    members: [],
  });
  useChatStore.setState({ messages: new Map([[CHANNEL, [first, later]]]), hasMore: new Map(), scrollPositions: new Map(), readStates: new Map() });
  useEphemeralReplyStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  useEphemeralReplyStore.getState().reset();
  useChatStore.setState({ messages: new Map(), hasMore: new Map(), scrollPositions: new Map() });
  useSpaceStore.setState({ spaceChannelIndex: new Map(), channelOriginMap: new Map(), channelPermissions: new Map(), members: [] });
  useAuthStore.setState({ user: null, myRowIds: new Map() });
});

describe('an answer only you can see', () => {
  it('sits in the timeline by its time, marked, and goes when dismissed', async () => {
    useEphemeralReplyStore.getState().add(answer);
    // Another chat's answer stays there.
    useEphemeralReplyStore.getState().add({ ...answer, id: 'e2', channelId: 'chan-2', content: 'elsewhere' });
    renderList();

    const text = await screen.findByText('Purged 5 messages');
    expect(screen.getByText('Only you can see this')).toBeTruthy();
    expect(screen.queryByText('elsewhere')).toBeNull();
    // Between the two messages it falls between.
    const before = screen.getByText('first from mira');
    const after = screen.getByText('later from mira');
    expect(before.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The message after it starts a group of its own, with its author's name.
    expect(screen.getAllByText('Mira')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Purged 5 messages')).toBeNull();
    expect(useEphemeralReplyStore.getState().byChat[CHANNEL]).toBeUndefined();
    expect(useEphemeralReplyStore.getState().byChat['chan-2']).toHaveLength(1);
  });

  it('is kept once and in time order', () => {
    const store = useEphemeralReplyStore.getState();
    store.add({ ...answer, id: 'late', createdAt: answer.createdAt + 10 });
    store.add(answer);
    store.add(answer);
    expect(useEphemeralReplyStore.getState().byChat[CHANNEL]?.map((r) => r.id)).toEqual(['e1', 'late']);
    store.add({ ...answer, id: 'dm', channelId: undefined, spaceId: undefined, dmChannelId: 'dm-9' });
    expect(useEphemeralReplyStore.getState().byChat['dm-9']?.map((r) => r.id)).toEqual(['dm']);
  });
});
