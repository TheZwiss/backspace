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
import { ALL_PERMISSIONS, permissionsToString } from '../../utils/permissions';
import {
  CHANNEL,
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
    detachedChannels: new Set(),
    readStates: new Map(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useChatStore.setState({ messages: new Map(), hasMore: new Map(), detachedChannels: new Set(), scrollPositions: new Map() });
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
