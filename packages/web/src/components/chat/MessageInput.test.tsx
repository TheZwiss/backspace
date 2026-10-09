import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { useTransferStore, type Transfer } from '../../stores/transferStore';
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
  useTransferStore.setState({ transfers: new Map() });
  window.history.replaceState({}, '', '/channels/@me/dm-1');
  useAuthStore.setState({ user: me });
  // dm-1 is a DM because the listing says so; the URL decides nothing.
  useSpaceStore.getState().reset();
  useSpaceStore.getState().populateFromReady('', [], [], [{
    id: 'dm-1',
    federatedId: null,
    ownerId: null,
    ownerHomeUserId: null,
    ownerHomeInstance: null,
    createdAt: 1,
    members: [me],
    lastMessage: null,
    name: null,
    icon: null,
    metadataUpdatedAt: 1,
  }]);
  useComposerStore.setState({ states: new Map() });
  useChatStore.setState({
    messages: new Map([['dm-1', [ownMessage]]]),
    replyTargets: new Map(),
    editingMessageId: null,
  });
});

afterEach(() => {
  cleanup();
  useTransferStore.setState({ transfers: new Map() });
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

describe('MessageInput staged attachment controls', () => {
  function stageTransfer(overrides: Partial<Transfer> = {}) {
    const transfer: Transfer = {
      id: 'upload-1',
      type: 'upload',
      state: 'completed',
      file: { name: 'photo.png', size: 1024, mimetype: 'image/png' },
      progress: { loaded: 1024, total: 1024 },
      channelId: 'dm-1',
      tray: true,
      ...overrides,
    };
    useTransferStore.setState({ transfers: new Map([[transfer.id, transfer]]) });
    useComposerStore.getState().attach('dm-1', transfer.id);
    return transfer;
  }

  it.each([
    { name: 'photo.png', size: 1024, mimetype: 'image/png' },
    { name: 'notes.txt', size: 1024, mimetype: 'text/plain' },
  ])('keeps the completed $name remove chip outside clipping layers', (file) => {
    const transfer = stageTransfer({ file });
    const abort = vi.spyOn(useTransferStore.getState(), 'abortUpload');
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);
    const removeButton = screen.getByRole('button', { name: 'Remove attachment' });

    // Negative offsets must not be clipped by the tile or a wrapper around it.
    expect(removeButton).toHaveClass('-top-2', '-right-2');
    expect(removeButton.closest('.overflow-hidden')).toBeNull();
    fireEvent.click(removeButton);

    expect(useTransferStore.getState().transfers.has(transfer.id)).toBe(false);
    expect(useComposerStore.getState().get('dm-1').stagedTransferIds).toEqual([]);
    expect(abort).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Remove attachment' })).not.toBeInTheDocument();
  });

  it.each(['queued', 'active', 'paused', 'failed'] as const)(
    'clips only the overlay for a %s upload and keeps cancellation working',
    (state) => {
      const transfer = stageTransfer({ state });
      const abort = vi.spyOn(useTransferStore.getState(), 'abortUpload').mockImplementation(() => {});
      render(<MessageInput channelId="dm-1" channelName="@Bob" />);
      const abortButton = screen.getByRole('button', { name: 'Abort' });
      const clip = abortButton.closest('.overflow-hidden');

      expect(clip).toHaveClass('absolute', 'inset-0', 'rounded-lg');
      expect(clip?.parentElement).not.toHaveClass('overflow-hidden');
      expect(screen.queryByRole('button', { name: 'Remove attachment' })).not.toBeInTheDocument();
      fireEvent.click(abortButton);
      expect(abort).toHaveBeenCalledWith(transfer.id);
      expect(useTransferStore.getState().transfers.has(transfer.id)).toBe(false);
      expect(useComposerStore.getState().get('dm-1').stagedTransferIds).toEqual([]);
    },
  );

  it.each([
    { state: 'active', label: 'Pause', action: 'pauseUpload' },
    { state: 'paused', label: 'Resume', action: 'resumeUpload' },
  ] as const)('preserves the $label action inside the overlay', async ({ state, label, action }) => {
    const transfer = stageTransfer({ state });
    const control = vi.spyOn(useTransferStore.getState(), action).mockResolvedValue(undefined);
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })); });
    expect(control).toHaveBeenCalledWith(transfer.id);
  });

  it('switches from the clipped progress overlay to an unclipped remove chip on completion', () => {
    const transfer = stageTransfer({ state: 'active' });
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    act(() => { useTransferStore.getState().setState_(transfer.id, 'completed'); });

    expect(screen.queryByRole('button', { name: 'Abort' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove attachment' }).closest('.overflow-hidden')).toBeNull();
  });

  it('removes only this channel attachment while preserving other drafts and uploads', () => {
    const transfer = stageTransfer();
    const otherTransfer: Transfer = { ...transfer, id: 'upload-other', channelId: 'dm-2' };
    useTransferStore.setState({ transfers: new Map([[transfer.id, transfer], [otherTransfer.id, otherTransfer]]) });
    useComposerStore.getState().attach('dm-2', otherTransfer.id);
    useComposerStore.getState().setDraft('dm-1', 'keep this draft');
    render(<MessageInput channelId="dm-1" channelName="@Bob" />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));

    expect(useComposerStore.getState().get('dm-1').draftText).toBe('keep this draft');
    expect(useComposerStore.getState().get('dm-2').stagedTransferIds).toEqual([otherTransfer.id]);
    expect(useTransferStore.getState().transfers.get(otherTransfer.id)).toEqual(otherTransfer);
  });
});
