import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { HttpError } from '../../api/client';
import { MessageInput } from './MessageInput';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn(), wsSendAll: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

interface SendBody {
  content: string;
  replyToId?: string;
}

// Answers like the DM route: a reply must target a message in the same DM
// channel, otherwise 400 `reply_target_invalid`.
const { send } = vi.hoisted(() => ({
  send: vi.fn<(channelId: string, body: SendBody) => Promise<void>>(),
}));
vi.mock('../../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    channels: { sendMessage: send },
    dm: { sendMessage: send },
  }),
}));

const me: User = {
  id: 'me',
  username: 'alice',
  displayName: 'Alice',
  avatar: null,
  banner: null,
  accentColor: null,
  avatarColor: null,
  bio: null,
  status: 'online',
  customStatus: null,
  isAdmin: false,
  createdAt: 1,
  homeInstance: null,
  homeUserId: null,
  replicatedInstances: [],
};

const bob: User = { ...me, id: 'bob', username: 'bob', displayName: 'Bob' };

const bobsMessage: MessageWithUser = {
  id: 'message-1',
  channelId: '',
  userId: bob.id,
  replyToId: null,
  content: 'reply to me',
  editedAt: null,
  createdAt: 1,
  user: bob,
  attachments: [],
  embeds: [],
  reactions: [],
};

beforeEach(() => {
  window.history.replaceState({}, '', '/channels/@me/dm-1');
  useAuthStore.setState({ user: me });
  useSpaceStore.getState().reset();
  useSpaceStore.getState().populateFromReady('', [], [], [
    { id: 'dm-1', federatedId: null, createdAt: 1, members: [me, bob] },
    { id: 'dm-2', federatedId: null, createdAt: 1, members: [me] },
  ]);
  useComposerStore.setState({ states: new Map() });
  useChatStore.setState({
    messages: new Map([['dm-1', [bobsMessage]], ['dm-2', []]]),
    replyTargets: new Map(),
    editingMessageId: null,
  });
  send.mockImplementation(async (channelId, body) => {
    if (!body.replyToId) return;
    const messages = useChatStore.getState().messages.get(channelId) ?? [];
    if (!messages.some((m) => m.id === body.replyToId)) {
      throw new HttpError(400, 'Reply target not found in this channel', undefined, 'reply_target_invalid');
    }
  });
});

afterEach(() => {
  send.mockReset();
  useChatStore.getState().clearAllMessages();
  useComposerStore.setState({ states: new Map() });
  useAuthStore.setState({ user: null });
  useSpaceStore.getState().reset();
  window.history.replaceState({}, '', '/');
});

describe('reply context across conversations (#390)', () => {
  it('shows the reply banner only in the conversation it was started in', () => {
    const { rerender } = render(<MessageInput channelId="dm-1" channelName="@Bob" />);
    act(() => { useChatStore.getState().setReplyTo('dm-1', bobsMessage); });
    expect(screen.getByLabelText('Cancel reply')).toBeInTheDocument();

    rerender(<MessageInput channelId="dm-2" channelName="@Alice" />);
    expect(screen.queryByLabelText('Cancel reply')).not.toBeInTheDocument();
    // Nor is the reply saved into the other conversation's draft.
    expect(useComposerStore.getState().get('dm-2').replyTo).toBeNull();

    rerender(<MessageInput channelId="dm-1" channelName="@Bob" />);
    expect(screen.getByLabelText('Cancel reply')).toBeInTheDocument();
    expect(useComposerStore.getState().get('dm-1').replyTo?.id).toBe('message-1');
  });

  it('keeps a message sent in another conversation instead of deleting it', async () => {
    const { rerender } = render(<MessageInput channelId="dm-1" channelName="@Bob" />);
    act(() => { useChatStore.getState().setReplyTo('dm-1', bobsMessage); });
    rerender(<MessageInput channelId="dm-2" channelName="@Alice" />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'hello there' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    expect(send).toHaveBeenCalledWith('dm-2', expect.objectContaining({ content: 'hello there', replyToId: undefined }));
    const sent = useChatStore.getState().messages.get('dm-2') ?? [];
    expect(sent.map((m) => m.content)).toEqual(['hello there']);
    expect(useChatStore.getState().replyTargets.get('dm-1')).toBe(bobsMessage);
  });

  it('cancelling the reply clears it in this conversation only', () => {
    useChatStore.getState().setReplyTo('dm-2', { ...bobsMessage, id: 'message-2' });
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);
    act(() => { useChatStore.getState().setReplyTo('dm-1', bobsMessage); });

    fireEvent.click(screen.getByLabelText('Cancel reply'));

    expect(useChatStore.getState().replyTargets.has('dm-1')).toBe(false);
    expect(useChatStore.getState().replyTargets.get('dm-2')?.id).toBe('message-2');
  });
});
