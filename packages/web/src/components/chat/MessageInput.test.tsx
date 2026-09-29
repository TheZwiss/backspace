import { api } from '../../api/client';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { act } from '@testing-library/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberWithUser, MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { Message } from './Message';
import { MessageInput } from './MessageInput';
import { PermissionBits } from '@backspace/shared/src/permissions';

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
  useSpaceStore.setState({ dmChannels: [] });
  useComposerStore.setState({ states: new Map() });
  useChatStore.setState({
    messages: new Map([['dm-1', [ownMessage]]]),
    replyTo: null,
    editingMessageId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useChatStore.getState().clearAllMessages();
  useComposerStore.setState({ states: new Map() });
  useAuthStore.setState({ user: null });
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


describe('MessageInput mention composition', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useSpaceStore.setState({
      channelToSpaceMap: new Map([['dm-1', 'space-1']]),
      members: [{ spaceId: 'space-1', userId: 'me', user: me, roles: [] }] as unknown as MemberWithUser[],
      roles: [],
      channelPermissions: new Map([['dm-1', (PermissionBits.SEND_MESSAGES).toString()]]),
    });
  });
  it('selects a displayed user name while storing the stable wire token', async () => {
    const sendMessage = vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValue(undefined);
    const { container } = render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@', selectionStart: 1 } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.value).toBe('@Alice '));
    expect(useComposerStore.getState().states.get('dm-1')?.draftText).toBe('<@me> ');
    expect(container.querySelector('[aria-hidden="true"] .text-accent-primary')).toHaveTextContent('@Alice');
    await waitFor(() => expect(input.selectionStart).toBe(7));
    fireEvent.change(input, { target: { value: '@Alice hello', selectionStart: 12 } });
    expect(useComposerStore.getState().states.get('dm-1')?.draftText).toBe('<@me> hello');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('dm-1', '<@me> hello'));
    await waitFor(() => expect(input.value).toBe(''));
    sendMessage.mockRestore();
  });
  it('keeps IME Enter from selecting a user', () => {
    render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '@', selectionStart: 1 } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(useComposerStore.getState().states.get('dm-1')?.draftText).toBe('@');
  });
});

describe('author context menu mention', () => {
  it('keeps message and avatar context menus separate', () => {
    useSpaceStore.setState({ channelPermissions: new Map([['dm-1', String(PermissionBits.SEND_MESSAGES)]]) });
    const { container } = render(<Message message={ownMessage} isCompact={false} isFirstInGroup previousMessageId={null} />);
    fireEvent.contextMenu(screen.getByText('last message'));
    const keys = useContextMenuStore.getState().menu!.items.map(item => item.key);
    expect(keys).toEqual(expect.arrayContaining(['reply', 'copy-text', 'mark-unread', 'edit', 'delete']));
    expect(keys).not.toContain('mention-author');
    expect(keys).not.toContain('poke-author');
    fireEvent.contextMenu(container.querySelector('[data-poke-user]')!);
    expect(useContextMenuStore.getState().menu!.items.map(item => item.key)).toEqual(['mention-author', 'poke-author']);
  });
  it('appends a mention to the existing draft and focuses the displayed name', async () => {
    useSpaceStore.setState({ members: [{ userId: me.id, user: me } as MemberWithUser], channelPermissions: new Map([['dm-1', String(PermissionBits.SEND_MESSAGES)]]) });
    useComposerStore.getState().setDraft('dm-1', 'hello');
    render(<><Message message={ownMessage} isCompact={false} isFirstInGroup previousMessageId={null} /><MessageInput channelId="dm-1" channelName="general" /></>);
    fireEvent.contextMenu(screen.getByText('Alice'));
    const menu = useContextMenuStore.getState().menu!.items;
    expect(menu.map(item => item.key)).toEqual(['mention-author', 'poke-author']);
    const mention = menu.find(item => item.key === 'mention-author');
    expect(mention?.type).toBe('action');
    act(() => { if (mention?.type === 'action') mention.onClick(); });
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('hello <@me> ');
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => { expect(input).toHaveValue('hello @Alice '); expect(input).toHaveFocus(); expect(input.selectionStart).toBe(input.value.length); });
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
  });
});

it('sends a personal sticker without discarding the current text draft', async () => {
  const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
  vi.spyOn(api.stickers, 'list').mockResolvedValue([{ id: 'a'.repeat(64), name: 'Happy', token }]);
  const send = vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  useComposerStore.getState().setDraft('dm-1', 'unfinished draft');
  render(<MessageInput channelId="dm-1" channelName="general" />);
  fireEvent.click(screen.getByRole('button', { name: 'Emoji picker' }));
  fireEvent.click(screen.getByRole('button', { name: 'My stickers' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Happy' }));
  expect(send).toHaveBeenCalledWith('dm-1', token);
  expect(screen.getByRole('textbox')).toHaveValue('unfinished draft');
});

it('offers collection only in the sticker context menu and keeps existing message actions', async () => {
  const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
  const collect = vi.spyOn(api.stickers, 'collect').mockResolvedValue({ id: 'a'.repeat(64), name: 'Happy', token });
  render(<Message message={{ ...ownMessage, content: token }} isCompact={false} isFirstInGroup previousMessageId={null} />);
  expect(screen.queryByRole('button', { name: 'Add to my stickers' })).not.toBeInTheDocument();
  fireEvent.contextMenu(screen.getByAltText('My stickers'));
  const items = useContextMenuStore.getState().menu!.items;
  expect(items.map(item => item.key)).toEqual(expect.arrayContaining(['collect-sticker', 'save-image', 'copy-image', 'reply', 'delete']));
  const item = items.find(item => item.key === 'collect-sticker');
  await act(async () => { if (item?.type === 'action') await item.onClick(); });
  expect(collect).toHaveBeenCalledWith({ id: 'a'.repeat(64), token });
});
