import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MessageWithUser, User } from '@backspace/shared';

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
import { isMe, useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { usePendingMessageStore, type PendingBubble } from '../../stores/pendingMessageStore';
import { ALL_PERMISSIONS, permissionsToString } from '../../utils/permissions';

// The account is native to the page's instance (nova); the channel is on
// orbit, which knows the user as o-7. Orbit's own Mira has id n-1, the id the
// session row has on nova.
const ORBIT = 'https://orbit.example';
const CHANNEL = 'orbit-chan';

const me = { id: 'n-1', username: 'jannis', displayName: 'Jannis', avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;
const orbitMira = { id: 'n-1', username: 'mira', displayName: 'Mira', avatar: null, homeInstance: null, homeUserId: null, createdAt: 1 } as unknown as User;

const miraMessage: MessageWithUser = {
  id: 'm1', channelId: CHANNEL, userId: orbitMira.id, replyToId: null, content: 'hi from mira',
  editedAt: null, createdAt: 1_700_000_000_000, user: orbitMira, attachments: [], embeds: [], reactions: [],
};

const bubble: PendingBubble = {
  clientId: 'c1', channelId: CHANNEL, content: 'my upload', replyToId: null, transferIds: [],
  createdAtLocal: 1_700_000_030_000, state: 'sending', tusExpiresAt: Number.MAX_SAFE_INTEGER, retryCount: 0,
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
  latestMessages.mockResolvedValue([miraMessage]);
  useAuthStore.setState({ user: me, myRowIds: new Map([[ORBIT, 'o-7']]) });
  useSpaceStore.setState({
    spaceChannelIndex: new Map([[CHANNEL, 'orbit-space']]),
    channelOriginMap: new Map([[CHANNEL, ORBIT]]),
    channelPermissions: new Map([[CHANNEL, permissionsToString(ALL_PERMISSIONS)]]),
    dmChannels: [],
    members: [],
  });
  useChatStore.setState({ messages: new Map([[CHANNEL, [miraMessage]]]), hasMore: new Map(), scrollPositions: new Map(), readStates: new Map() });
  usePendingMessageStore.setState({ bubbles: new Map([[CHANNEL, [bubble]]]) });
});

afterEach(() => {
  vi.restoreAllMocks();
  usePendingMessageStore.setState({ bubbles: new Map() });
  useChatStore.setState({ messages: new Map(), hasMore: new Map(), scrollPositions: new Map() });
  useSpaceStore.setState({ spaceChannelIndex: new Map(), channelOriginMap: new Map(), channelPermissions: new Map(), members: [] });
  useAuthStore.setState({ user: null, myRowIds: new Map() });
});

describe('pending bubbles on another instance', () => {
  it("are the user's row as the channel's instance knows it", async () => {
    const openUserProfile = vi.fn();
    useUIStore.setState({ openUserProfile });
    renderList();
    await screen.findByText('my upload');

    // Not folded into the group of orbit's user who has the session row's id.
    fireEvent.click(await screen.findByText('Jannis'));
    expect(openUserProfile).toHaveBeenCalledTimes(1);
    const [row, origin] = openUserProfile.mock.calls[0] as [User, string];
    expect(origin).toBe(ORBIT);
    expect(row.id).toBe('o-7');
    expect(isMe(row, origin)).toBe(true);
  });

  it('carry the session row on the page instance', async () => {
    useSpaceStore.setState({ channelOriginMap: new Map([[CHANNEL, '']]) });
    const openUserProfile = vi.fn();
    useUIStore.setState({ openUserProfile });
    const other = { ...orbitMira, id: 'n-2' } as User;
    const otherMessage = { ...miraMessage, userId: 'n-2', user: other };
    latestMessages.mockResolvedValue([otherMessage]);
    useChatStore.setState({ messages: new Map([[CHANNEL, [otherMessage]]]) });
    renderList();
    await screen.findByText('my upload');
    fireEvent.click(await screen.findByText('Jannis'));
    const [row, origin] = openUserProfile.mock.calls[0] as [User, string];
    expect(origin).toBe('');
    expect(row).toBe(me);
  });
});
