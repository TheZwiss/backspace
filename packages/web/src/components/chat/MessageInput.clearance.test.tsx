import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useComposerStore } from '../../stores/composerStore';
import { useSpaceStore } from '../../stores/spaceStore';
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

const me = {
  id: 'me',
  username: 'alice',
  displayName: 'Alice',
  avatar: null,
  createdAt: 1,
  replicatedInstances: [],
} as unknown as User;

const other: MessageWithUser = {
  id: '41',
  channelId: '',
  userId: 'u-bob',
  replyToId: null,
  content: 'reply to me',
  editedAt: null,
  createdAt: 1,
  user: { ...me, id: 'u-bob', username: 'bob' } as User,
  attachments: [],
  embeds: [],
  reactions: [],
};

/**
 * The chat region the composer writes `--composer-clearance` onto. Every
 * write and removal is recorded in order, so a removal between two writes
 * (the transient that let the browser clamp the list, issue #361) shows up.
 */
function renderInRegion() {
  const writes: Array<string | null> = [];
  const view = render(
    <div data-testid="region">
      <MessageInput channelId="dm-1" channelName="@Bob" />
    </div>,
  );
  const region = view.getByTestId('region');
  const setProperty = region.style.setProperty.bind(region.style);
  const removeProperty = region.style.removeProperty.bind(region.style);
  vi.spyOn(region.style, 'setProperty').mockImplementation((name, value, priority) => {
    if (name === '--composer-clearance') writes.push(value ?? '');
    setProperty(name, value, priority);
  });
  vi.spyOn(region.style, 'removeProperty').mockImplementation((name) => {
    if (name === '--composer-clearance') writes.push(null);
    return removeProperty(name);
  });
  return { ...view, region, writes };
}

/** jsdom has no visualViewport; the composer's focus tracking needs one. */
function stubVisualViewport(): void {
  const viewport = Object.assign(new EventTarget(), {
    height: window.innerHeight,
    width: window.innerWidth,
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    scale: 1,
  });
  vi.stubGlobal('visualViewport', viewport);
}

/** Let the focus tracking measure (it coalesces into an animation frame). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  stubVisualViewport();
  window.history.replaceState({}, '', '/channels/@me/dm-1');
  useAuthStore.setState({ user: me });
  useSpaceStore.setState({ dmChannels: [] });
  useComposerStore.setState({ states: new Map() });
  useChatStore.setState({ messages: new Map([['dm-1', [other]]]), replyTo: null, editingMessageId: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useChatStore.getState().clearAllMessages();
  useComposerStore.setState({ states: new Map() });
  useAuthStore.setState({ user: null });
  window.history.replaceState({}, '', '/');
});

describe('composer clearance (issue #361)', () => {
  it('is set on the chat region while the composer is mounted', () => {
    const { region } = renderInRegion();
    expect(region.style.getPropertyValue('--composer-clearance')).toMatch(/^\d+px$/);
  });

  it('is never dropped when the window loses and regains focus', async () => {
    const { region, writes } = renderInRegion();
    const textbox = screen.getByRole('textbox');

    // Leaving the window blurs the focused textarea; coming back focuses it.
    fireEvent.focusIn(textbox);
    await settle();
    fireEvent.focusOut(textbox);
    await settle();
    fireEvent.focusIn(textbox);
    await settle();

    expect(writes).not.toContain(null);
    expect(region.style.getPropertyValue('--composer-clearance')).toMatch(/^\d+px$/);
  });

  it('is never dropped when a reply starts or ends', () => {
    const { region, writes } = renderInRegion();

    act(() => { useChatStore.getState().setReplyTo(other); });
    act(() => { useChatStore.getState().setReplyTo(null); });

    expect(writes).not.toContain(null);
    expect(region.style.getPropertyValue('--composer-clearance')).toMatch(/^\d+px$/);
  });

  it('is removed when the composer unmounts', () => {
    const { region, unmount } = renderInRegion();
    unmount();
    expect(region.style.getPropertyValue('--composer-clearance')).toBe('');
  });
});
