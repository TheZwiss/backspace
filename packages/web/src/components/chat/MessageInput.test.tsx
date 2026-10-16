import { useContextMenuStore } from '../../stores/contextMenuStore';
import { api } from '../../api/client';
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
  useContextMenuStore.getState().close();
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

describe('MessageInput slash commands', () => {
  // jsdom does not implement scrollIntoView; the command popover scrolls its selection.
  beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });

  const play = {
    id: 'cmd-1',
    name: 'play',
    description: 'Play a song',
    options: [],
    botId: 'bot-1',
    updatedAt: 1,
    bot: { id: 'bot-1', username: 'radio_bot', displayName: null, avatar: null, avatarColor: null },
  };

  it('invokes a command once however often Enter is pressed while it is on its way', async () => {
    vi.spyOn(api.commands, 'forChat').mockResolvedValue({ commands: [play] } as never);
    let finish!: () => void;
    const invoking = new Promise<never>(resolve => { finish = () => resolve({ id: 'i1' } as never); });
    const invoke = vi.spyOn(api.commands, 'invoke').mockReturnValue(invoking);
    useComposerStore.getState().setDraft('dm-1', '/play');
    render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { finish(); await invoking; });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('');
  });

  it('puts the command back when the invocation fails', async () => {
    vi.spyOn(api.commands, 'forChat').mockResolvedValue({ commands: [play] } as never);
    vi.spyOn(api.commands, 'invoke').mockRejectedValue(new Error('Bot offline'));
    useComposerStore.getState().setDraft('dm-1', '/play');
    render(<MessageInput channelId="dm-1" channelName="general" />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('/play'));
    expect(useUIStore.getState().toasts).toEqual([expect.objectContaining({ message: 'Bot offline', type: 'warning' })]);
  });

  it('offers the people of the chat for a user option and invokes with the picked id', async () => {
    // The list offers the other people of the DM, never oneself.
    const bob: User = { ...me, id: 'bob', username: 'bob', displayName: 'Bob' };
    useSpaceStore.getState().reset();
    useSpaceStore.getState().populateFromReady('', [], [], [{
      id: 'dm-1',
      federatedId: null,
      ownerId: null,
      ownerHomeUserId: null,
      ownerHomeInstance: null,
      createdAt: 1,
      members: [me, bob],
      lastMessage: null,
      name: null,
      icon: null,
      metadataUpdatedAt: 1,
    }]);
    const poke = { ...play, id: 'cmd-2', name: 'poke', options: [{ name: 'who', description: 'Who', type: 'user', required: true }] };
    vi.spyOn(api.commands, 'forChat').mockResolvedValue({ commands: [poke] } as never);
    const invoke = vi.spyOn(api.commands, 'invoke').mockResolvedValue({ id: 'i1', expiresAt: 1 } as never);
    render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '/', selectionStart: 1 } });
    await waitFor(() => expect(api.commands.forChat).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    // Picking the command opens the list of people at once.
    fireEvent.change(input, { target: { value: '/po', selectionStart: 3 } });
    fireEvent.click(await screen.findByText('/poke'));
    expect(await screen.findByText('Bob')).toBeTruthy();
    // The required option is written with the composer's spacing, ready for its value.
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('/poke\u2003who:\u2009\u2002');

    fireEvent.change(input, { target: { value: '/poke who:bo', selectionStart: 12 } });
    expect(await screen.findByText('Bob')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Tab' });
    await waitFor(() => expect(input).toHaveValue('/poke who:@Bob'));
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('/poke who:<@bob>');
    // Nothing is offered after a picked value, so this Enter sends.
    expect(screen.queryByText('Bob')).toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      command: 'poke',
      options: { who: 'bob' },
      dmChannelId: 'dm-1',
    })));
  });

  it('offers the choices of an option by name and sends the chosen value; a space opens the next options', async () => {
    const play2 = {
      ...play,
      id: 'cmd-3',
      name: 'volume',
      options: [
        { name: 'level', description: 'Level', type: 'integer', required: true, choices: [{ name: 'quiet', value: 20 }, { name: 'loud', value: 80 }] },
        { name: 'fade', description: 'Fade', type: 'boolean', required: false },
      ],
    };
    vi.spyOn(api.commands, 'forChat').mockResolvedValue({ commands: [play2] } as never);
    const invoke = vi.spyOn(api.commands, 'invoke').mockResolvedValue({ id: 'i1', expiresAt: 1 } as never);
    render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '/vol', selectionStart: 4 } });
    fireEvent.click(await screen.findByText('/volume'));
    expect(await screen.findByText('quiet')).toBeTruthy();
    fireEvent.change(input, { target: { value: '/volume level:lo', selectionStart: 16 } });
    expect(await screen.findByText('loud')).toBeTruthy();
    expect(screen.queryByText('quiet')).toBeNull();
    fireEvent.keyDown(input, { key: 'Tab' });
    await waitFor(() => expect(input).toHaveValue('/volume level:loud'));

    // A space after the value offers the options not written yet.
    fireEvent.change(input, { target: { value: '/volume level:loud ', selectionStart: 19 } });
    expect(await screen.findByText('fade:')).toBeTruthy();
    fireEvent.change(input, { target: { value: '/volume level:loud', selectionStart: 18 } });

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      command: 'volume',
      options: { level: 80 },
    })));

    // A pasted command gets the same spacing as picked arguments.
    fireEvent.change(input, { target: { value: '/volume level:loud fade:true', selectionStart: 28 } });
    expect(useComposerStore.getState().get('dm-1').draftText)
      .toBe('/volume\u2003level:\u2009\u2002loud\u2003\u2002fade:\u2009\u2002true');
  });

  it('lists each subcommand, writes its path and invokes it with the path', async () => {
    const music = {
      ...play,
      id: 'cmd-4',
      name: 'music',
      options: [
        { name: 'play', description: 'Play now', type: 'subcommand', required: false, options: [] },
        { name: 'queue', description: 'The queue', type: 'subcommand_group', required: false, options: [
          { name: 'add', description: 'Add a track', type: 'subcommand', required: false, options: [
            { name: 'level', description: 'Level', type: 'integer', required: true, choices: [{ name: 'loud', value: 80 }] },
          ] },
          { name: 'clear', description: 'Empty it', type: 'subcommand', required: false, options: [] },
        ] },
      ],
    };
    vi.spyOn(api.commands, 'forChat').mockResolvedValue({ commands: [music] } as never);
    const invoke = vi.spyOn(api.commands, 'invoke').mockResolvedValue({ id: 'i1', expiresAt: 1 } as never);
    render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox');

    // The command list has a row per subcommand.
    fireEvent.change(input, { target: { value: '/mu', selectionStart: 3 } });
    expect(await screen.findByText('/music play')).toBeTruthy();
    expect(screen.getByText('/music queue clear')).toBeTruthy();
    fireEvent.click(screen.getByText('/music queue add'));
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('/music queue add\u2003level:\u2009\u2002');
    expect(await screen.findByText('loud')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Tab' });
    await waitFor(() => expect(useComposerStore.getState().get('dm-1').draftText).toBe('/music queue add\u2003level:\u2009\u2002loud'));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      command: 'music',
      subcommand: ['queue', 'add'],
      options: { level: 80 },
    })));

    // Typed by hand, the next step is offered after each space.
    fireEvent.change(input, { target: { value: '/music ', selectionStart: 7 } });
    expect(await screen.findByText('queue')).toBeTruthy();
    expect(screen.getByText('play')).toBeTruthy();
    fireEvent.change(input, { target: { value: '/music q', selectionStart: 8 } });
    fireEvent.keyDown(input, { key: 'Tab' });
    await waitFor(() => expect(useComposerStore.getState().get('dm-1').draftText).toBe('/music queue '));
    expect(await screen.findByText('clear')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Tab' });
    await waitFor(() => expect(useComposerStore.getState().get('dm-1').draftText).toBe('/music queue clear '));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ subcommand: ['queue', 'clear'], options: {} })));
  });

  it('does not send a command with subcommands before one is chosen', async () => {
    const music = {
      ...play,
      id: 'cmd-5',
      name: 'music',
      options: [
        { name: 'play', description: 'Play now', type: 'subcommand', required: false, options: [] },
        { name: 'stop', description: 'Stop', type: 'subcommand', required: false, options: [] },
      ],
    };
    vi.spyOn(api.commands, 'forChat').mockResolvedValue({ commands: [music] } as never);
    const invoke = vi.spyOn(api.commands, 'invoke').mockResolvedValue({ id: 'i1', expiresAt: 1 } as never);
    useComposerStore.getState().setDraft('dm-1', '/music');
    render(<MessageInput channelId="dm-1" channelName="general" />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(useUIStore.getState().toasts).toEqual([
      expect.objectContaining({ message: 'Choose a subcommand: play, stop', type: 'warning' }),
    ]));
    expect(invoke).not.toHaveBeenCalled();
    expect(useComposerStore.getState().get('dm-1').draftText).toBe('/music');
  });

  it('asks for the command list again when a new command starts', async () => {
    const forChat = vi.spyOn(api.commands, 'forChat').mockResolvedValue({ commands: [play] } as never);
    render(<MessageInput channelId="dm-1" channelName="general" />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '/', selectionStart: 1 } });
    await waitFor(() => expect(forChat).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: '/p', selectionStart: 2 } });
    expect(forChat).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: '', selectionStart: 0 } });
    fireEvent.change(input, { target: { value: '/', selectionStart: 1 } });
    await waitFor(() => expect(forChat).toHaveBeenCalledTimes(2));
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
  const stickerButton = await screen.findByRole('button', { name: 'Happy' });
  await act(async () => { fireEvent.click(stickerButton); });
  expect(send).toHaveBeenCalledWith('dm-1', token);
  expect(screen.getByRole('textbox')).toHaveValue('unfinished draft');
});

it('offers collection only in the sticker context menu and keeps existing message actions', async () => {
  const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
  const collect = vi.spyOn(api.stickers, 'collect').mockResolvedValue({ id: 'a'.repeat(64), name: 'Happy', token });
  // DM wire messages carry dmChannelId, not a guild channelId.
  const stickerMessage = { ...ownMessage, channelId: '', dmChannelId: 'dm-1', content: token };
  render(<Message message={stickerMessage} isCompact={false} isFirstInGroup previousMessageId={null} />);
  expect(screen.queryByRole('button', { name: 'Add to my stickers' })).not.toBeInTheDocument();
  fireEvent.contextMenu(screen.getByAltText('Sticker'));
  const items = useContextMenuStore.getState().menu!.items;
  expect(items.map(item => item.key)).toEqual(expect.arrayContaining(['collect-sticker', 'save-image', 'copy-image', 'reply', 'delete']));
  // A sticker's content is a token: it cannot be edited or copied as text.
  expect(items.map(item => item.key)).not.toContain('edit');
  expect(items.find(item => item.key === 'copy-text')).toMatchObject({ hidden: true });
  const item = items.find(item => item.key === 'collect-sticker');
  await act(async () => { if (item?.type === 'action') await item.onClick(); });
  expect(collect).toHaveBeenCalledWith({ id: 'a'.repeat(64), token, name: 'Sticker' });
});

it('draws a sticker once even when an older instance unfurled its asset URL', () => {
  const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
  const assetUrl = token.slice('sticker:'.length);
  const embed = {
    id: 'embed-1', messageId: ownMessage.id, dmMessageId: null, url: assetUrl, embedType: 'image' as const,
    provider: null, title: null, description: null, image: assetUrl, embedUrl: null, width: 8, height: 8, color: null, createdAt: 1,
  };
  const { container } = render(<Message message={{ ...ownMessage, content: token, embeds: [embed] }} isCompact={false} isFirstInGroup previousMessageId={null} />);
  // querySelectorAll, not getAllByRole: an embed image has an empty alt and so no img role.
  expect([...container.querySelectorAll('img')].filter(img => img.getAttribute('src') === assetUrl)).toHaveLength(1);
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

  it('revokes the preview URL of a picked image when its tile is removed', async () => {
    const created = 'blob:preview-photo';
    const revoke = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => created });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke });
    try {
      vi.spyOn(useTransferStore.getState(), 'startUpload').mockImplementation(async (file, opts) => {
        const transfer: Transfer = {
          id: 'upload-picked',
          type: 'upload',
          state: 'completed',
          file: { name: 'photo.png', size: file.size, mimetype: 'image/png' },
          progress: { loaded: file.size, total: file.size },
          channelId: opts.channelId,
          tray: true,
        };
        useTransferStore.setState({ transfers: new Map([[transfer.id, transfer]]) });
        return transfer.id;
      });
      const { container } = render(<MessageInput channelId="dm-1" channelName="@Bob" />);
      const input = container.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('file input not rendered');

      fireEvent.change(input, { target: { files: [new File(['png'], 'photo.png', { type: 'image/png' })] } });
      expect(await screen.findByRole('img', { name: 'photo.png' })).toHaveAttribute('src', created);

      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));
      expect(revoke).toHaveBeenCalledWith(created);
      expect(useComposerStore.getState().get('dm-1').stagedTransferIds).toEqual([]);
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else delete (URL as { createObjectURL?: unknown }).createObjectURL;
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
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
