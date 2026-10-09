import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { Message } from './Message';
import { MessageInput } from './MessageInput';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
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

const ownMessage: MessageWithUser = {
  id: 'message-1',
  channelId: 'dm-1',
  userId: me.id,
  replyToId: null,
  content: 'last message',
  editedAt: null,
  createdAt: 1,
  user: me,
  attachments: [],
  embeds: [],
  reactions: [],
};

beforeEach(() => {
  window.history.replaceState({}, '', '/channels/@me/dm-1');
  useAuthStore.setState({ user: me });
  // dm-1 is a DM because the listing says so; the URL decides nothing.
  useSpaceStore.getState().reset();
  useSpaceStore.getState().populateFromReady('', [], [], [{ id: 'dm-1', federatedId: null, createdAt: 1, members: [me], ownerId: null, ownerHomeUserId: null, ownerHomeInstance: null, lastMessage: null, name: null, icon: null, metadataUpdatedAt: 1 }]);
  useComposerStore.setState({ states: new Map() });
  useChatStore.setState({
    messages: new Map([['dm-1', [ownMessage]]]),
    replyTargets: new Map(),
    editingMessageId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useUIStore.setState({ toasts: [] });
  useChatStore.getState().clearAllMessages();
  useComposerStore.setState({ states: new Map() });
  useAuthStore.setState({ user: null });
  useSpaceStore.getState().reset();
  window.history.replaceState({}, '', '/');
});

describe('MessageInput edit shortcut', () => {
  it('opens the last own message when ArrowUp is pressed in an empty composer', async () => {
    render(
      <>
        <Message message={ownMessage} isCompact={false} isFirstInGroup previousMessageId={null} />
        <MessageInput channelId="dm-1" channelName="@Bob" />
      </>,
    );

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp' });

    expect(useChatStore.getState().editingMessageId).toBe('message-1');
    const editor = screen.getByDisplayValue('last message') as HTMLTextAreaElement;
    await waitFor(() => {
      expect(editor).toHaveFocus();
      expect(editor.selectionStart).toBe('last message'.length);
      expect(editor.selectionEnd).toBe('last message'.length);
    });
  });

  it('preserves a non-empty draft instead of starting message editing', () => {
    useComposerStore.getState().setDraft('dm-1', 'unfinished draft');
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp' });

    expect(useChatStore.getState().editingMessageId).toBeNull();
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('unfinished draft');
  });

  it('preserves an active reply instead of starting message editing', () => {
    useComposerStore.getState().setReplyTo('dm-1', {
      id: 'reply-target',
      userId: 'other',
      content: 'original message',
    });
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp' });

    expect(useChatStore.getState().editingMessageId).toBeNull();
    expect(useComposerStore.getState().get('dm-1').replyTo?.id).toBe('reply-target');
  });
});

describe('MessageInput slow sends', () => {
  it('consumes a draft immediately, prevents repeated Enter and preserves subsequent typing', async () => {
    let finish!: () => void;
    const sending = new Promise<void>(resolve => { finish = resolve; });
    const send = vi.spyOn(useChatStore.getState(), 'sendMessage').mockReturnValue(sending);
    useComposerStore.getState().setDraft('dm-1', 'first');
    render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: 'next draft' } });
    await act(async () => { finish(); await sending; });
    expect(input).toHaveValue('next draft');
  });

  it('retains failed text without overwriting a newer draft', async () => {
    let fail!: (error: Error) => void;
    const sending = new Promise<void>((_resolve, reject) => { fail = reject; });
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockReturnValue(sending);
    useComposerStore.getState().setDraft('dm-1', 'failed text');
    render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'new text' } });
    await act(async () => { fail(new Error('Offline')); await sending.catch(() => {}); });
    expect(input).toHaveValue('failed text\nnew text');
    expect(useUIStore.getState().toasts).toEqual([expect.objectContaining({ message: 'Offline', type: 'warning' })]);
  });
});


describe('MessageInput mention display', () => {
  it('renders a readable label but submits the stored wire ID', async () => {
    const send = vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValue(undefined);
    useComposerStore.getState().setDraft('dm-1', 'Hi <@me>');
    render(<MessageInput channelId="dm-1" channelName="@Alice" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('Hi @Alice');
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(send).toHaveBeenCalledWith('dm-1', 'Hi <@me>');
  });

  it('edits after a mention without replacing its wire ID with a label', () => {
    useComposerStore.getState().setDraft('dm-1', '<@me> hello');
    render(<MessageInput channelId="dm-1" channelName="@Alice" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@Alice hello!', selectionStart: 13 } });
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('<@me> hello!');
  });

  it('removes the complete mention when an edit touches its displayed name', () => {
    useComposerStore.getState().setDraft('dm-1', '<@me> ');
    render(<MessageInput channelId="dm-1" channelName="@Alice" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@Alic ', selectionStart: 5 } });
    expect(useComposerStore.getState().get('dm-1').draftText).toBe(' ');
    expect(screen.getByRole('textbox')).toHaveValue(' ');
  });

  it('does not send a draft when Enter confirms an IME composition', () => {
    const send = vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValue(undefined);
    useComposerStore.getState().setDraft('dm-1', '<@me> 你好');
    render(<MessageInput channelId="dm-1" channelName="@Alice" />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    expect(send).not.toHaveBeenCalled();
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('<@me> 你好');
  });
});
