import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const messagesAround = vi.fn();
const latestMessages = vi.fn();
vi.mock('../../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    channels: {
      messagesAround: (...args: unknown[]) => messagesAround(...args),
      messages: (...args: unknown[]) => latestMessages(...args),
    },
  }),
}));

import { MessageList } from './MessageList';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { HttpError } from '../../api/client';
import { ALL_PERMISSIONS, permissionsToString } from '../../utils/permissions';

const CHANNEL = 'chan-1';

function user(id: string, username: string): User {
  return { id, username, displayName: null, avatar: null, createdAt: 1 } as unknown as User;
}

const me = user('me', 'jannis');
const mira = user('u-mira', 'mira');

function msg(id: string, content: string, extra: Partial<MessageWithUser> = {}): MessageWithUser {
  return {
    id,
    channelId: CHANNEL,
    userId: mira.id,
    replyToId: null,
    content,
    editedAt: null,
    createdAt: 1_700_000_000_000 + Number(id) * 60_000,
    user: mira,
    attachments: [],
    embeds: [],
    reactions: [],
    ...extra,
  };
}

const scrollIntoView = vi.fn();

function renderList() {
  return render(
    <MemoryRouter>
      <MessageList channelId={CHANNEL} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  messagesAround.mockReset();
  latestMessages.mockReset();
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  useAuthStore.setState({ user: me });
  useSpaceStore.setState({
    channelOriginMap: new Map([[CHANNEL, '']]),
    channelPermissions: new Map([[CHANNEL, permissionsToString(ALL_PERMISSIONS)]]),
    dmChannels: [],
  });
  useUIStore.setState({ toasts: [] });
  // An unmount saves the list's anchor; each test opens the channel fresh.
  useChatStore.setState({ scrollPositions: new Map() });
});

afterEach(() => {
  vi.restoreAllMocks();
  useChatStore.setState({ messages: new Map(), hasMore: new Map(), detachedChannels: new Set(), scrollPositions: new Map() });
  useSpaceStore.setState({ members: [], currentSpaceId: null, channelToSpaceMap: new Map() });
});

interface Layout {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  /** Viewport top of each message row by message id; the list itself sits at 0. */
  rowTop: Record<string, number>;
}

/**
 * jsdom has no layout. Give the scroll container real dimensions and the
 * message rows positions, so the jump can work out where it lands.
 */
function stubLayout(layout: Layout): void {
  const isList = (el: Element) => el.classList.contains('overflow-y-auto');
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return isList(this) ? layout.scrollHeight : 0;
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return isList(this) ? layout.clientHeight : 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
    return isList(this) ? layout.scrollTop : 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
    if (isList(this)) layout.scrollTop = Math.min(value, layout.scrollHeight - layout.clientHeight);
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = this.id.startsWith('msg-') ? layout.rowTop[this.id.slice(4)] ?? 0 : 0;
    return new DOMRect(0, top, 600, 40);
  });
}

/** True once Effect A has smooth-scrolled the bottom sentinel (a div with no id) into view. */
function followedToBottom(): boolean {
  return scrollIntoView.mock.contexts.some((el) => el instanceof HTMLElement && el.id === '');
}

describe('message viewport resizing', () => {
  let observers: TestResizeObserver[];

  class TestResizeObserver {
    targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }

  function resize(target: Element) {
    act(() => {
      for (const observer of observers) {
        if (observer.targets.has(target)) {
          observer.callback([{ target } as ResizeObserverEntry], observer as unknown as ResizeObserver);
        }
      }
    });
  }

  beforeEach(() => {
    observers = [];
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    useChatStore.setState({
      messages: new Map([[CHANNEL, [msg('10', 'latest message')]]]),
      hasMore: new Map([[CHANNEL, false]]),
      scrollPositions: new Map(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps the latest message visible through keyboard open/close without content growth', async () => {
    const layout: Layout = { scrollHeight: 2000, clientHeight: 800, scrollTop: 0, rowTop: {} };
    stubLayout(layout);
    const { container } = renderList();
    const viewport = container.querySelector('.overflow-y-auto')!;
    await waitFor(() => expect(layout.scrollTop).toBe(1200));

    for (const height of [600, 400, 550, 800]) {
      layout.clientHeight = height;
      // Only the viewport changes: no message, embed or composer resize.
      resize(viewport);
      expect(layout.scrollTop).toBe(layout.scrollHeight - height);
      fireEvent.scroll(viewport);
    }
  });

  it('preserves the reading position when the user has scrolled up', async () => {
    const layout: Layout = { scrollHeight: 2000, clientHeight: 800, scrollTop: 0, rowTop: {} };
    stubLayout(layout);
    const { container } = renderList();
    const viewport = container.querySelector('.overflow-y-auto')!;
    await waitFor(() => expect(layout.scrollTop).toBe(1200));
    layout.scrollTop = 500;
    fireEvent.scroll(viewport);

    for (const height of [400, 800]) {
      layout.clientHeight = height;
      resize(viewport);
      expect(layout.scrollTop).toBe(500);
    }
  });

  it('disconnects viewport observation on unmount', () => {
    const { container, unmount } = renderList();
    const viewport = container.querySelector('.overflow-y-auto')!;
    expect(observers.some((observer) => observer.targets.has(viewport))).toBe(true);
    unmount();
    expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);
  });
});

describe('reply preview jump', () => {
  it('is a button that scrolls to and highlights a loaded original', async () => {
    const original = msg('10', 'where is the release checklist?');
    const reply = msg('11', 'in the wiki', { userId: me.id, user: me, replyToId: '10', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [original, reply]]]),
      hasMore: new Map([[CHANNEL, false]]),
    });
    renderList();

    const preview = screen.getByRole('button', { name: /jump to the original message/i });
    await userEvent.click(preview);

    const target = document.getElementById('msg-10');
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView.mock.contexts).toContain(target);
    expect(target).toHaveClass('message-jump-highlight');
    expect(messagesAround).not.toHaveBeenCalled();
  });

  it('jumps when the mention inside the preview is clicked, without opening a profile (issue #313)', async () => {
    const original = msg('10', 'ask <@u-mira> about the checklist');
    const reply = msg('11', 'in the wiki', { userId: me.id, user: me, replyToId: '10', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [original, reply]]]),
      hasMore: new Map([[CHANNEL, false]]),
    });
    // Mira is a member, so the badge resolves her and could open her profile.
    useSpaceStore.setState({
      members: [{ spaceId: 'space-1', userId: mira.id, nickname: null, joinedAt: 1, user: mira, roles: [] }],
      spaces: [],
      currentSpaceId: 'space-1',
      channelToSpaceMap: new Map([[CHANNEL, 'space-1']]),
    });
    const openUserProfile = vi.spyOn(useUIStore.getState(), 'openUserProfile');
    renderList();

    const preview = screen.getByRole('button', { name: /jump to the original message/i });
    const badge = within(preview).getByText('@mira');
    await userEvent.click(badge);

    expect(openUserProfile).not.toHaveBeenCalled();
    expect(document.getElementById('msg-10')).toHaveClass('message-jump-highlight');
  });

  it('moves keyboard focus to the original without scrolling again (issue #313)', async () => {
    const original = msg('10', 'where is the release checklist?');
    const reply = msg('11', 'in the wiki', { replyToId: '10', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [original, reply]]]),
      hasMore: new Map([[CHANNEL, false]]),
    });
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    renderList();

    const preview = screen.getByRole('button', { name: /jump to the original message/i });
    preview.focus();
    focus.mockClear();
    await userEvent.keyboard('{Enter}');

    const target = document.getElementById('msg-10');
    expect(target).toHaveFocus();
    expect(focus.mock.contexts).toContain(target);
    expect(focus.mock.calls[focus.mock.contexts.indexOf(target)]?.[0]).toEqual({ preventScroll: true });

    // Once focus moves on, the row goes back to not being a tab stop.
    preview.focus();
    expect(target).not.toHaveAttribute('tabindex');
  });

  it('leaves focus alone when the user moved it while the jump was loading (issue #313)', async () => {
    const original = msg('3', 'an old question');
    const reply = msg('60', 'answering that old question', { replyToId: '3', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [msg('59', 'recent'), reply]]]),
      hasMore: new Map([[CHANNEL, true]]),
    });
    let resolveLoad: (messages: MessageWithUser[]) => void = () => {};
    messagesAround.mockReturnValue(new Promise<MessageWithUser[]>((resolve) => { resolveLoad = resolve; }));
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    try {
      renderList();

      await userEvent.click(screen.getByRole('button', { name: /jump to the original message/i }));
      expect(messagesAround).toHaveBeenCalled();
      // The user starts typing while the window loads.
      composer.focus();

      await act(async () => { resolveLoad([msg('2', 'older'), original, msg('4', 'newer')]); });
      await waitFor(() => expect(document.getElementById('msg-3')).toHaveClass('message-jump-highlight'));

      expect(composer).toHaveFocus();
    } finally {
      composer.remove();
    }
  });

  it('is reachable and activated from the keyboard', async () => {
    const original = msg('10', 'where is the release checklist?');
    const reply = msg('11', 'in the wiki', { replyToId: '10', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [original, reply]]]),
      hasMore: new Map([[CHANNEL, false]]),
    });
    renderList();

    const preview = screen.getByRole('button', { name: /jump to the original message/i });
    preview.focus();
    expect(preview).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(document.getElementById('msg-10')).toHaveClass('message-jump-highlight');
  });

  it('loads the window around an original that is not loaded, then scrolls to it', async () => {
    const original = msg('3', 'an old question');
    const reply = msg('60', 'answering that old question', { replyToId: '3', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [msg('59', 'recent'), reply]]]),
      hasMore: new Map([[CHANNEL, true]]),
    });
    messagesAround.mockResolvedValue([msg('2', 'older'), original, msg('4', 'newer')]);
    renderList();

    await userEvent.click(screen.getByRole('button', { name: /jump to the original message/i }));

    expect(messagesAround).toHaveBeenCalledWith(CHANNEL, '3', 50);
    await waitFor(() => expect(document.getElementById('msg-3')).toHaveClass('message-jump-highlight'));
    expect(scrollIntoView.mock.contexts).toContain(document.getElementById('msg-3'));
  });

  it('shows a quiet hint and stays put when the original no longer exists', async () => {
    const original = msg('3', 'deleted since');
    const reply = msg('60', 'replying to something gone', { replyToId: '3', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [reply]]]),
      hasMore: new Map([[CHANNEL, true]]),
    });
    messagesAround.mockRejectedValue(new HttpError(404, 'Message not found', undefined, 'message_not_found'));
    renderList();

    await userEvent.click(screen.getByRole('button', { name: /jump to the original message/i }));

    await waitFor(() => expect(useUIStore.getState().toasts.map((t) => t.message)).toContain('That message is no longer available'));
    expect(useChatStore.getState().messages.get(CHANNEL)?.map((m) => m.id)).toEqual(['60']);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('keeps the jumped-to position when a new message arrives', async () => {
    const original = msg('3', 'an old question');
    const reply = msg('60', 'answering that old question', { replyToId: '3', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [msg('59', 'recent'), reply]]]),
      hasMore: new Map([[CHANNEL, true]]),
    });
    messagesAround.mockResolvedValue([msg('2', 'older'), original, msg('4', 'newer')]);
    // The loaded window is tall and the original sits far above the viewport.
    stubLayout({ scrollHeight: 5000, clientHeight: 500, scrollTop: 4500, rowTop: { '3': -3000 } });
    renderList();

    await userEvent.click(screen.getByRole('button', { name: /jump to the original message/i }));
    await waitFor(() => expect(document.getElementById('msg-3')).toHaveClass('message-jump-highlight'));
    scrollIntoView.mockClear();

    act(() => {
      useChatStore.getState().addRealtimeMessage(CHANNEL, msg('61', 'someone else speaks'));
    });

    // Effect A would smooth-scroll the bottom sentinel into view if the list
    // still believed it was at the bottom.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('keeps following new messages after a jump to a row already near the bottom', async () => {
    const original = msg('10', 'where is the release checklist?');
    const reply = msg('11', 'in the wiki', { replyToId: '10', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [original, reply]]]),
      hasMore: new Map([[CHANNEL, false]]),
    });
    // At the bottom, the original on screen: centring it clamps to the
    // bottom, so the list does not move and no scroll event follows.
    stubLayout({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500, rowTop: { '10': 300, '11': 380 } });
    renderList();

    await userEvent.click(screen.getByRole('button', { name: /jump to the original message/i }));
    expect(document.getElementById('msg-10')).toHaveClass('message-jump-highlight');
    scrollIntoView.mockClear();

    act(() => {
      useChatStore.getState().addRealtimeMessage(CHANNEL, msg('12', 'someone else speaks'));
    });

    await waitFor(() => expect(followedToBottom()).toBe(true));
  });

  it('takes a search jump request once, however often the parent re-renders', async () => {
    useChatStore.setState({
      messages: new Map([[CHANNEL, [msg('59', 'recent')]]]),
      hasMore: new Map([[CHANNEL, true]]),
    });
    messagesAround.mockRejectedValue(new HttpError(404, 'Message not found', undefined, 'message_not_found'));
    const handled = vi.fn();
    // A parent that passes a new callback on every render and has not
    // cleared the request yet.
    const list = () => (
      <MemoryRouter>
        <MessageList channelId={CHANNEL} jumpToMessageId="3" onJumpHandled={() => handled()} />
      </MemoryRouter>
    );
    const view = render(list());
    for (let i = 0; i < 4; i++) view.rerender(list());

    await waitFor(() => expect(useUIStore.getState().toasts.map((t) => t.message)).toContain('That message is no longer available'));
    for (let i = 0; i < 3; i++) view.rerender(list());
    expect(messagesAround).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it('Jump to Present after a jump into older history reloads the newest page', async () => {
    const original = msg('100', 'an old question');
    const reply = msg('500', 'answering that old question', { replyToId: '100', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [msg('499', 'recent'), reply]]]),
      hasMore: new Map([[CHANNEL, true]]),
    });
    // A full window: 25 older, the target, 25 newer. More history follows it.
    const window: MessageWithUser[] = [];
    for (let i = 75; i <= 125; i++) window.push(i === 100 ? original : msg(String(i), `history ${i}`));
    messagesAround.mockResolvedValue(window);
    latestMessages.mockResolvedValue([msg('499', 'recent'), reply]);
    renderList();

    await userEvent.click(screen.getByRole('button', { name: /jump to the original message/i }));
    await waitFor(() => expect(document.getElementById('msg-100')).toHaveClass('message-jump-highlight'));

    // The window's own bottom is not the present, so the button shows even
    // though the list is close to the window's end.
    await userEvent.click(screen.getByRole('button', { name: /jump to present/i }));

    expect(latestMessages).toHaveBeenCalledWith(CHANNEL);
    await waitFor(() => expect(document.getElementById('msg-500')).toBeInTheDocument());
    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(false);
    expect(document.getElementById('msg-100')).not.toBeInTheDocument();
  });

  it('tells the user and stays put when Jump to Present cannot load the newest page (issue #313)', async () => {
    const original = msg('100', 'an old question');
    const reply = msg('500', 'answering that old question', { replyToId: '100', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [msg('499', 'recent'), reply]]]),
      hasMore: new Map([[CHANNEL, true]]),
    });
    const window: MessageWithUser[] = [];
    for (let i = 75; i <= 125; i++) window.push(i === 100 ? original : msg(String(i), `history ${i}`));
    messagesAround.mockResolvedValue(window);
    latestMessages.mockRejectedValue(new Error('network down'));
    // A tall detached window, read somewhere in its middle.
    const layout = { scrollHeight: 5000, clientHeight: 500, scrollTop: 2000, rowTop: { '100': 0 } };
    stubLayout(layout);
    renderList();

    await userEvent.click(screen.getByRole('button', { name: /jump to the original message/i }));
    await waitFor(() => expect(document.getElementById('msg-100')).toHaveClass('message-jump-highlight'));
    layout.scrollTop = 2000;

    await userEvent.click(screen.getByRole('button', { name: /jump to present/i }));

    await waitFor(() => expect(useUIStore.getState().toasts.map((t) => t.message)).toContain("Couldn't load the latest messages"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(layout.scrollTop).toBe(2000);
    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(true);
    expect(document.getElementById('msg-100')).toBeInTheDocument();
  });
});
