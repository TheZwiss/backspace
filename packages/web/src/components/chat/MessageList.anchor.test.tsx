import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { MessageWithUser } from '@backspace/shared';

const wsSend = vi.fn();
vi.mock('../../hooks/useWebSocket', () => ({
  wsSend: (...args: unknown[]) => wsSend(...args),
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
const newerMessages = vi.fn();
vi.mock('../../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    channels: {
      messagesAround: (...args: unknown[]) => messagesAround(...args),
      messages: (...args: unknown[]) => latestMessages(...args),
      messagesAfter: (...args: unknown[]) => newerMessages(...args),
    },
  }),
}));

import { MessageList } from './MessageList';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { ALL_PERMISSIONS, permissionsToString } from '../../utils/permissions';
import { HttpError } from '../../api/client';
import {
  CHANNEL,
  ROW_HEIGHT,
  me,
  msg,
  installBoxResizeObserver,
  resizeElement,
  stackRows,
  stubScrollLayout,
  type ScrollLayout,
} from './messageListTestKit';

const scrollIntoView = vi.fn();

function list() {
  return (
    <MemoryRouter>
      <MessageList channelId={CHANNEL} />
    </MemoryRouter>
  );
}

function ids(from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(String(i));
  return out;
}

function page(from: number, to: number): MessageWithUser[] {
  return ids(from, to).map((id) => msg(id, `message ${id}`));
}

function viewport(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('.overflow-y-auto')!;
}

function content(container: HTMLElement): HTMLElement {
  return viewport(container).querySelector<HTMLElement>('.pt-4')!;
}

/** A user scroll: the offset moves, then the browser reports it. */
function userScrollTo(layout: ScrollLayout, el: HTMLElement, top: number): void {
  layout.scrollTop = top;
  fireEvent.scroll(el);
}

beforeEach(() => {
  wsSend.mockReset();
  messagesAround.mockReset();
  latestMessages.mockReset();
  newerMessages.mockReset();
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  installBoxResizeObserver();
  useAuthStore.setState({ user: me });
  useSpaceStore.setState({
    channelOriginMap: new Map([[CHANNEL, '']]),
    channelPermissions: new Map([[CHANNEL, permissionsToString(ALL_PERMISSIONS)]]),
    dmChannels: [],
  });
  useUIStore.setState({ toasts: [] });
  useChatStore.setState({
    messages: new Map([[CHANNEL, page(1, 60)]]),
    hasMore: new Map([[CHANNEL, false]]),
    scrollPositions: new Map(),
    detachedChannels: new Map(),
    presentReturns: new Map(),
    readStates: new Map(),
    realtimeMessageEvents: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useChatStore.setState({ messages: new Map(), hasMore: new Map(), detachedChannels: new Map(), scrollPositions: new Map() });
});

describe('composer clearance (issue #361)', () => {
  it('keeps the newest message above the composer when the composer grows', async () => {
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    const { container } = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(2000));

    // A multi-line draft raises --composer-clearance: only the content's
    // bottom padding grows, its content box does not.
    layout.scrollHeight = 2880;
    resizeElement(content(container), 'padding');

    expect(layout.scrollTop).toBe(2080);
  });
});

describe('reading position (issue #374)', () => {
  function readingAt(layout: ScrollLayout, container: HTMLElement): void {
    // Row 21 sits at the viewport top, 10 px of it scrolled out of view.
    userScrollTo(layout, viewport(container), layout.rowY['21']! + 10);
  }

  it('holds the reading position when the open channel is reloaded under it', async () => {
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    const { container } = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(2000));
    readingAt(layout, container);
    const reading = layout.scrollTop;

    // The cache is dropped and refetched while the channel stays open.
    act(() => {
      const messages = new Map(useChatStore.getState().messages);
      messages.delete(CHANNEL);
      useChatStore.setState({ messages });
    });
    act(() => {
      useChatStore.setState({ messages: new Map([[CHANNEL, page(1, 60)]]) });
    });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

    expect(layout.scrollTop).toBe(reading);
  });

  it('loads the window around the reading position when the reload no longer holds it', async () => {
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    messagesAround.mockResolvedValue(page(1, 45));
    const { container } = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(2000));
    readingAt(layout, container);

    act(() => {
      const messages = new Map(useChatStore.getState().messages);
      messages.delete(CHANNEL);
      useChatStore.setState({ messages });
    });
    act(() => {
      useChatStore.setState({ messages: new Map([[CHANNEL, page(100, 150)]]), hasMore: new Map([[CHANNEL, true]]) });
    });

    await waitFor(() => expect(messagesAround).toHaveBeenCalledWith(CHANNEL, '21', 50));
    await waitFor(() => expect(document.getElementById('msg-21')).toBeInTheDocument());
  });

  it('loads the window around the reading position when a newest-page reload drops it', async () => {
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    messagesAround.mockResolvedValue(page(1, 45));
    const { container } = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(2000));
    readingAt(layout, container);

    // A forced reload of the newest page: it overlaps the old cache but no
    // longer reaches the row being read.
    act(() => {
      useChatStore.setState({ messages: new Map([[CHANNEL, page(30, 60)]]), hasMore: new Map([[CHANNEL, true]]) });
    });

    await waitFor(() => expect(messagesAround).toHaveBeenCalledWith(CHANNEL, '21', 50));
  });

  it('holds the row now at the top when the anchored row is deleted', async () => {
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    const { container } = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(2000));
    readingAt(layout, container);
    const reading = layout.scrollTop;

    act(() => {
      useChatStore.getState().removeMessage('21', CHANNEL);
    });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

    expect(messagesAround).not.toHaveBeenCalled();
    expect(layout.scrollTop).toBe(reading);
  });

  it('restores the reading position after the list is remounted', async () => {
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    const first = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(2000));
    readingAt(layout, first.container);
    const reading = layout.scrollTop;
    first.unmount();

    // A fresh container starts at the top.
    layout.scrollTop = 0;
    render(list());

    await waitFor(() => expect(layout.scrollTop).toBe(reading));
  });
});

describe('Jump to Present (issue #329)', () => {
  it('does not override a jump started while it loads', async () => {
    const history: MessageWithUser[] = [];
    for (let i = 75; i <= 125; i++) {
      history.push(i === 110
        ? msg('110', 'about that', { replyToId: '90', replyTo: msg('90', 'history 90') })
        : msg(String(i), `history ${i}`));
    }
    const original = msg('100', 'an old question');
    history[25] = original;
    const reply = msg('500', 'answering that old question', { replyToId: '100', replyTo: original });
    useChatStore.setState({
      messages: new Map([[CHANNEL, [msg('499', 'recent'), reply]]]),
      hasMore: new Map([[CHANNEL, true]]),
    });
    const layout: ScrollLayout = { scrollHeight: 2400, clientHeight: 400, scrollTop: 0, rowY: stackRows([...ids(75, 125), '499', '500'], 216) };
    stubScrollLayout(layout);
    messagesAround.mockResolvedValue(history);
    render(list());

    await userEvent.click(screen.getByRole('button', { name: /jump to the original message/i }));
    await waitFor(() => expect(document.getElementById('msg-100')).toHaveClass('message-jump-highlight'));

    let resolvePresent: (messages: MessageWithUser[]) => void = () => {};
    latestMessages.mockReturnValue(new Promise<MessageWithUser[]>((resolve) => { resolvePresent = resolve; }));
    await userEvent.click(screen.getByRole('button', { name: /jump to present/i }));

    // While the newest page loads, the user follows a reply inside the window.
    const preview = within(document.getElementById('msg-110')!).getByRole('button', { name: /jump to the original message/i });
    await userEvent.click(preview);
    expect(document.getElementById('msg-90')).toHaveClass('message-jump-highlight');
    messagesAround.mockClear();

    await act(async () => { resolvePresent([msg('499', 'recent'), reply]); });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    // The newer jump wins: the list goes back to its target, not to the bottom.
    await waitFor(() => expect(messagesAround).toHaveBeenCalledWith(CHANNEL, '90', 50));
  });
});

describe('read acks', () => {
  function acks(): unknown[] {
    return wsSend.mock.calls.filter(([event]) => (event as { type: string }).type === 'channel_ack').map(([event]) => event);
  }

  it('marks the channel read once the view is at the newest message', async () => {
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    render(list());
    await waitFor(() => expect(acks()).toEqual([{ type: 'channel_ack', channelId: CHANNEL, messageId: '60' }]));
  });

  it('does not mark the channel read while the view is above the newest message', async () => {
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    const { container } = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(2000));
    // Scrolled up a few rows: near the bottom, not at it.
    userScrollTo(layout, viewport(container), 1600);
    wsSend.mockClear();

    act(() => {
      useChatStore.getState().addRealtimeMessage(CHANNEL, msg('61', 'someone else speaks'));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(acks()).toEqual([]);
  });
});

describe('opening at the first unread message (issue #375)', () => {
  const UNREAD_ROW_OFFSET = 64;

  function acks(): unknown[] {
    return wsSend.mock.calls.filter(([event]) => (event as { type: string }).type === 'channel_ack').map(([event]) => event);
  }

  function dividerBefore(messageId: string): boolean {
    const divider = screen.queryByRole('separator', { name: /new messages/i });
    if (!divider) return false;
    const row = document.getElementById(`msg-${messageId}`);
    return !!row && divider.compareDocumentPosition(row) === Node.DOCUMENT_POSITION_FOLLOWING
      && (divider.nextElementSibling === row || divider.nextElementSibling?.contains(row) === true);
  }

  it('opens at the first unread message with a divider above it, without marking it read', async () => {
    useChatStore.setState({ readStates: new Map([[CHANNEL, '40']]) });
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    render(list());

    await waitFor(() => expect(layout.scrollTop).toBe(layout.rowY['41']! - UNREAD_ROW_OFFSET));
    expect(dividerBefore('41')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(acks()).toEqual([]);
  });

  it("starts after the viewer's own messages", async () => {
    const rows = page(1, 60).map((m) => (m.id === '41' ? { ...m, userId: me.id, user: me } : m));
    useChatStore.setState({ messages: new Map([[CHANNEL, rows]]), readStates: new Map([[CHANNEL, '40']]) });
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    render(list());

    await waitFor(() => expect(layout.scrollTop).toBe(layout.rowY['42']! - UNREAD_ROW_OFFSET));
    expect(dividerBefore('42')).toBe(true);
  });

  it('opens at the latest message when everything is read', async () => {
    useChatStore.setState({ readStates: new Map([[CHANNEL, '60']]) });
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    render(list());

    await waitFor(() => expect(layout.scrollTop).toBe(2000));
    expect(screen.queryByRole('separator', { name: /new messages/i })).toBeNull();
  });

  it('follows new messages and marks the channel read when the unread ones fit on screen', async () => {
    useChatStore.setState({ readStates: new Map([[CHANNEL, '58']]) });
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    render(list());

    await waitFor(() => expect(layout.scrollTop).toBe(2000));
    expect(dividerBefore('59')).toBe(true);
    await waitFor(() => expect(acks()).toEqual([{ type: 'channel_ack', channelId: CHANNEL, messageId: '60' }]));
  });

  it('loads the window around the read position when the unread messages start before the newest page', async () => {
    useChatStore.setState({
      messages: new Map([[CHANNEL, page(100, 149)]]),
      hasMore: new Map([[CHANNEL, true]]),
      readStates: new Map([[CHANNEL, '60']]),
    });
    messagesAround.mockResolvedValue(page(36, 85));
    const layout: ScrollLayout = { scrollHeight: 2400, clientHeight: 800, scrollTop: 0, rowY: stackRows([...ids(36, 85), ...ids(100, 149)], 216) };
    stubScrollLayout(layout);
    render(list());

    await waitFor(() => expect(messagesAround).toHaveBeenCalledWith(CHANNEL, '60', 50));
    await waitFor(() => expect(dividerBefore('61')).toBe(true));
    await waitFor(() => expect(layout.scrollTop).toBe(layout.rowY['61']! - UNREAD_ROW_OFFSET));
  });

  it('opens at the latest message when the read message is gone', async () => {
    useChatStore.setState({
      messages: new Map([[CHANNEL, page(100, 149)]]),
      hasMore: new Map([[CHANNEL, true]]),
      readStates: new Map([[CHANNEL, '60']]),
    });
    messagesAround.mockRejectedValue(new HttpError(404, 'Message not found', undefined, 'message_not_found'));
    const layout: ScrollLayout = { scrollHeight: 2400, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(100, 149), 216) };
    stubScrollLayout(layout);
    render(list());

    await waitFor(() => expect(layout.scrollTop).toBe(1600));
    expect(useUIStore.getState().toasts).toEqual([]);
  });

  it('moves the divider when a message is marked unread', async () => {
    const layout: ScrollLayout = { scrollHeight: 2800, clientHeight: 800, scrollTop: 0, rowY: stackRows(ids(1, 60), 16) };
    stubScrollLayout(layout);
    render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(2000));
    expect(screen.queryByRole('separator', { name: /new messages/i })).toBeNull();
    await waitFor(() => expect(useChatStore.getState().readStates.get(CHANNEL)).toBe('60'));

    act(() => { useChatStore.getState().markUnread(CHANNEL, '54'); });

    expect(dividerBefore('55')).toBe(true);
  });
});

describe('a channel that fails to load (issue #329)', () => {
  it('says so and offers to try again', async () => {
    useChatStore.setState({ messages: new Map(), hasMore: new Map(), loadStates: new Map() });
    latestMessages.mockRejectedValueOnce(new Error('Network request failed'));
    render(list());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load messages");
    expect(alert).toHaveTextContent('Network request failed');
    // The scroll container stays mounted under the overlay.
    expect(document.querySelector('.overflow-y-auto')).toBeInTheDocument();

    latestMessages.mockResolvedValueOnce(page(1, 3));
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(document.getElementById('msg-3')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows nothing for a failure in another channel', async () => {
    useChatStore.setState({ loadStates: new Map([['chan-other', { status: 'failed', error: new Error('down') }]]) });
    render(list());
    await waitFor(() => expect(document.getElementById('msg-60')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('a detached window pages forward', () => {
  const UNREAD_ROW_OFFSET = 64;
  // The pagination slot and the content's top padding sit above the first
  // row; the composer clearance below the last.
  const FIRST_ROW_Y = 216;
  const CLEARANCE = 80;

  function acks(): unknown[] {
    return wsSend.mock.calls.filter(([event]) => (event as { type: string }).type === 'channel_ack').map(([event]) => event);
  }

  /**
   * Rows stacked from the first rendered one, and a scroll height that grows
   * with the rows actually rendered, as a browser's would when a page is
   * appended below the view.
   */
  function growingLayout(rowY: Record<string, number>): ScrollLayout {
    return {
      get scrollHeight() {
        return FIRST_ROW_Y + document.querySelectorAll('[id^="msg-"]').length * ROW_HEIGHT + CLEARANCE;
      },
      set scrollHeight(_value: number) { /* derived from the rendered rows */ },
      clientHeight: 800,
      scrollTop: 0,
      rowY,
    };
  }

  function scrollToEnd(layout: ScrollLayout, container: HTMLElement): void {
    userScrollTo(layout, viewport(container), layout.scrollHeight - layout.clientHeight);
  }

  /** The newer pages the channel's origin serves, by cursor. */
  function servePagesAfter(pages: Record<string, MessageWithUser[]>, forward = true): void {
    newerMessages.mockImplementation((_channelId: string, after: string) =>
      Promise.resolve({ messages: pages[after] ?? [], forward }));
  }

  /** The channel opens at its first unread message, 61, in the window around 60 (36-85). */
  function unreadBeyondOnePage(): void {
    useChatStore.setState({
      messages: new Map([[CHANNEL, page(101, 150)]]),
      hasMore: new Map([[CHANNEL, true]]),
      readStates: new Map([[CHANNEL, '60']]),
    });
    messagesAround.mockResolvedValue(page(36, 85));
  }

  it('opens at the first unread message, pages forward to the newest message as the user reads, and marks the channel read there', async () => {
    unreadBeyondOnePage();
    servePagesAfter({ '85': page(86, 135), '135': page(136, 150) });
    const layout = growingLayout(stackRows(ids(36, 150), FIRST_ROW_Y));
    stubScrollLayout(layout);
    const { container } = render(list());

    await waitFor(() => expect(layout.scrollTop).toBe(layout.rowY['61']! - UNREAD_ROW_OFFSET));
    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(true);
    expect(newerMessages).not.toHaveBeenCalled();

    // The user reads to the end of the window: the next page loads and is
    // appended below without moving the view.
    scrollIntoView.mockClear();
    scrollToEnd(layout, container);
    const atWindowEnd = layout.scrollTop;
    await waitFor(() => expect(document.getElementById('msg-135')).toBeInTheDocument());
    expect(newerMessages).toHaveBeenCalledWith(CHANNEL, '85', 50);
    expect(layout.scrollTop).toBe(atWindowEnd);
    // Held to the row being read, not followed down the new rows.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(acks()).toEqual([]);

    // The next page is shorter than the limit: it reaches the newest message.
    scrollToEnd(layout, container);
    const atSecondEnd = layout.scrollTop;
    await waitFor(() => expect(document.getElementById('msg-150')).toBeInTheDocument());
    expect(newerMessages).toHaveBeenLastCalledWith(CHANNEL, '135', 50);
    expect(layout.scrollTop).toBe(atSecondEnd);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(false);
    expect(useChatStore.getState().messages.get(CHANNEL)?.map((m) => m.id)).toEqual(ids(36, 150));
    expect(acks()).toEqual([]);

    // Reading on to the newest message marks the channel read.
    scrollToEnd(layout, container);
    await waitFor(() => expect(acks()).toEqual([{ type: 'channel_ack', channelId: CHANNEL, messageId: '150' }]));
    expect(newerMessages).toHaveBeenCalledTimes(2);
  });

  it('pages forward from a window restored around the reading position', async () => {
    const layout = growingLayout(stackRows(ids(1, 60), FIRST_ROW_Y));
    stubScrollLayout(layout);
    messagesAround.mockResolvedValue(page(1, 46));
    servePagesAfter({ '46': page(47, 60) });
    const { container } = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(layout.scrollHeight - layout.clientHeight));
    userScrollTo(layout, viewport(container), layout.rowY['21']! + 10);
    const reading = layout.scrollTop;

    // A reconnect reloads the newest page, which no longer holds row 21: the
    // window around it is loaded back, and it stops short of the newest message.
    act(() => {
      useChatStore.setState({ messages: new Map([[CHANNEL, page(100, 150)]]), hasMore: new Map([[CHANNEL, true]]) });
    });
    await waitFor(() => expect(messagesAround).toHaveBeenCalledWith(CHANNEL, '21', 50));
    await waitFor(() => expect(layout.scrollTop).toBe(reading));
    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(true);

    scrollToEnd(layout, container);
    const atWindowEnd = layout.scrollTop;
    await waitFor(() => expect(document.getElementById('msg-60')).toBeInTheDocument());
    expect(newerMessages).toHaveBeenCalledWith(CHANNEL, '46', 50);
    expect(layout.scrollTop).toBe(atWindowEnd);
    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(false);
  });

  it('takes the newest page as a return to the present when the origin ignores the cursor', async () => {
    unreadBeyondOnePage();
    // A server that predates forward paging answers with its newest page and
    // no paging header.
    servePagesAfter({ '85': page(101, 150) }, false);
    const layout = growingLayout({ ...stackRows(ids(36, 85), FIRST_ROW_Y), ...stackRows(ids(101, 150), FIRST_ROW_Y) });
    stubScrollLayout(layout);
    const { container } = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(layout.rowY['61']! - UNREAD_ROW_OFFSET));

    scrollToEnd(layout, container);

    await waitFor(() => expect(document.getElementById('msg-36')).not.toBeInTheDocument());
    // Not spliced after the window: the window is replaced, and attached.
    expect(useChatStore.getState().messages.get(CHANNEL)?.map((m) => m.id)).toEqual(ids(101, 150));
    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(false);
    expect(layout.scrollTop).toBe(layout.scrollHeight - layout.clientHeight);
    await waitFor(() => expect(acks()).toEqual([{ type: 'channel_ack', channelId: CHANNEL, messageId: '150' }]));
    expect(newerMessages).toHaveBeenCalledTimes(1);
  });

  it('holds live messages back while detached and shows them once the window reaches the newest message', async () => {
    unreadBeyondOnePage();
    servePagesAfter({ '85': page(86, 100) });
    const layout = growingLayout(stackRows([...ids(36, 100), '200'], FIRST_ROW_Y));
    stubScrollLayout(layout);
    const { container } = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(layout.rowY['61']! - UNREAD_ROW_OFFSET));
    const opened = layout.scrollTop;

    act(() => {
      useChatStore.getState().addRealtimeMessage(CHANNEL, msg('200', 'someone else speaks'));
    });

    // Not after the window, where it would hide the gap before it.
    expect(document.getElementById('msg-200')).not.toBeInTheDocument();
    expect(useChatStore.getState().realtimeMessageEvents.map((e) => e.message.id)).toEqual(['200']);
    expect(layout.scrollTop).toBe(opened);
    expect(screen.getByRole('button', { name: /jump to present/i })).toBeInTheDocument();

    scrollToEnd(layout, container);

    await waitFor(() => expect(document.getElementById('msg-200')).toBeInTheDocument());
    expect(useChatStore.getState().messages.get(CHANNEL)?.slice(-2).map((m) => m.id)).toEqual(['100', '200']);
    expect(useChatStore.getState().detachedChannels.has(CHANNEL)).toBe(false);
  });

  it('leaves the next channel alone when the user switches away while a page loads', async () => {
    const OTHER = 'chan-2';
    unreadBeyondOnePage();
    useChatStore.setState({ messages: new Map([...useChatStore.getState().messages, [OTHER, page(300, 310).map((m) => ({ ...m, channelId: OTHER }))]]) });
    useSpaceStore.setState({
      channelOriginMap: new Map([[CHANNEL, ''], [OTHER, '']]),
      channelPermissions: new Map([[CHANNEL, permissionsToString(ALL_PERMISSIONS)], [OTHER, permissionsToString(ALL_PERMISSIONS)]]),
    });
    let resolvePage: (page: { messages: MessageWithUser[]; forward: boolean }) => void = () => {};
    newerMessages.mockReturnValue(new Promise((resolve) => { resolvePage = resolve; }));
    const layout = growingLayout({ ...stackRows(ids(36, 135), FIRST_ROW_Y), ...stackRows(ids(300, 310), FIRST_ROW_Y) });
    stubScrollLayout(layout);
    const view = render(list());
    await waitFor(() => expect(layout.scrollTop).toBe(layout.rowY['61']! - UNREAD_ROW_OFFSET));
    scrollToEnd(layout, view.container);
    await waitFor(() => expect(newerMessages).toHaveBeenCalledWith(CHANNEL, '85', 50));

    view.rerender(
      <MemoryRouter>
        <MessageList channelId={OTHER} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(document.getElementById('msg-310')).toBeInTheDocument());
    const onOther = layout.scrollTop;

    await act(async () => { resolvePage({ messages: page(86, 135), forward: true }); });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    // The open channel keeps its rows and its position. The page still
    // continues the window it was asked for, which the channel's saved
    // reading position is in.
    expect(document.getElementById('msg-135')).not.toBeInTheDocument();
    expect(useChatStore.getState().messages.get(OTHER)?.map((m) => m.id)).toEqual(ids(300, 310));
    expect(useChatStore.getState().messages.get(CHANNEL)?.at(-1)?.id).toBe('135');
    expect(layout.scrollTop).toBe(onOther);
    expect(newerMessages).toHaveBeenCalledTimes(1);
  });
});
