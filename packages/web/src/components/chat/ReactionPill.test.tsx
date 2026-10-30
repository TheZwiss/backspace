import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Reaction, User } from '@backspace/shared';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { ReactionPill } from './ReactionPill';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { api, HttpError } from '../../api/client';

function user(id: string, username: string, displayName: string | null = null, homeInstance: string | null = null): User {
  return { id, username, displayName, avatar: null, createdAt: 1, homeInstance, homeUserId: homeInstance ? `${id}-home` : null } as unknown as User;
}

const ME = user('me', 'jannis', 'Jannis');
const MIRA = user('mira', 'mira', 'Mira');
const TOVE_STUB = user('tove-local', 'tove@orbit.example', null, 'orbit.example');

function reaction(reactor: User, at: number): Reaction {
  return { id: `r-${reactor.id}`, messageId: 'm1', userId: reactor.id, emoji: '🎉', createdAt: at, user: reactor };
}

beforeEach(() => {
  vi.useFakeTimers();
  useAuthStore.setState({ user: ME });
  useUIStore.setState({ isMobile: false });
  useSpaceStore.setState({ userViews: new Map() });
});

afterEach(() => {
  vi.useRealTimers();
});

function renderPill(reactions: Reaction[], onToggle = vi.fn()) {
  render(<ReactionPill emoji="🎉" reactions={reactions} origin="" onToggle={onToggle} />);
  return screen.getByRole('button');
}

describe('ReactionPill', () => {
  it('shows who reacted after a short hover', () => {
    const pill = renderPill([reaction(MIRA, 1), reaction(ME, 2)]);

    fireEvent.mouseEnter(pill);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(400); });

    expect(screen.getByRole('tooltip')).toHaveTextContent('You and Mira reacted');

    fireEvent.mouseLeave(pill);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows the same text on keyboard focus and hides it on Escape', () => {
    const pill = renderPill([reaction(MIRA, 1)]);
    // Keyboard focus: the browser matches :focus-visible.
    vi.spyOn(pill, 'matches').mockImplementation((selector) => selector === ':focus-visible');

    fireEvent.focus(pill);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Mira reacted');

    fireEvent.keyDown(pill, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes a tooltip opened by hover on Escape, and keeps it closed while the pointer stays (issue #313)', () => {
    const pill = renderPill([reaction(MIRA, 1)]);

    fireEvent.mouseEnter(pill);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // The pill is hovered, not focused: Escape reaches the document.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('cancels a pending keyboard tooltip on Escape within the show delay (issue #313)', () => {
    const pill = renderPill([reaction(MIRA, 1)]);
    vi.spyOn(pill, 'matches').mockImplementation((selector) => selector === ':focus-visible');

    fireEvent.focus(pill);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.keyDown(pill, { key: 'Escape' });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('cancels a pending hover tooltip on Escape within the show delay (issue #313)', () => {
    const pill = renderPill([reaction(MIRA, 1)]);

    fireEvent.mouseEnter(pill);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('does not open on the focus a mouse click leaves behind', () => {
    const pill = renderPill([reaction(MIRA, 1)]);
    // Pointer focus: :focus-visible does not match.
    vi.spyOn(pill, 'matches').mockReturnValue(false);

    fireEvent.focus(pill);
    act(() => { vi.advanceTimersByTime(400); });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('gives the button the sentence as its accessible description and its state', () => {
    const pill = renderPill([reaction(ME, 1), reaction(MIRA, 2)]);
    expect(pill).toHaveAccessibleName(/2/);
    expect(pill).toHaveAccessibleDescription('You and Mira reacted');
    expect(pill).toHaveAttribute('aria-pressed', 'true');
  });

  it("names a remote user by the best view of them this client has", () => {
    // The channel's origin knows Tove only as a stub; her home instance's
    // view (with a display name) reached the userViews cache.
    useSpaceStore.setState({
      userViews: new Map([['orbit.example:tove-local-home', {
        user: { ...TOVE_STUB, displayName: 'Tove' },
        deliveredBy: 'https://orbit.example',
        isHome: true,
        updatedAt: 1,
      }]]),
    });
    const pill = renderPill([reaction(TOVE_STUB, 1)]);
    expect(pill).toHaveAccessibleDescription('Tove reacted');
  });

  it('toggles on click', () => {
    const onToggle = vi.fn();
    const pill = renderPill([reaction(MIRA, 1)], onToggle);
    fireEvent.click(pill);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows no hover tooltip on touch layouts', () => {
    useUIStore.setState({ isMobile: true });
    const pill = renderPill([reaction(MIRA, 1)]);
    fireEvent.mouseEnter(pill);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(pill).toHaveAccessibleDescription('Mira reacted');
  });
});

it('shows a sticker preview with reactors and preserves toggle behavior', () => {
  const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
  const toggle = vi.fn();
  render(<ReactionPill emoji={token} origin="" reactions={[{ ...reaction(MIRA, 1), emoji: token }]} onToggle={toggle} />);
  expect(screen.getByRole('img')).toHaveAttribute('src', token.slice('sticker:'.length));
  fireEvent.mouseEnter(screen.getByRole('button'));
  act(() => { vi.advanceTimersByTime(400); });
  expect(screen.getByRole('tooltip')).toHaveTextContent('Mira reacted');
  expect(screen.getByRole('tooltip')).toHaveClass('flex-col');
  const tooltip = screen.getByRole('tooltip');
  expect(tooltip.firstElementChild).toContainElement(screen.getByAltText('Preview sticker'));
  expect(tooltip.lastElementChild).toHaveTextContent('Mira reacted');
  expect(screen.getAllByRole('img')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button'));
  expect(toggle).toHaveBeenCalledOnce();
});

describe('sticker reaction menu', () => {
  const ID = 'b'.repeat(64);
  const remoteToken = `sticker:https://remote.test/api/stickers/assets/${ID}.webp`;
  const saved = { id: 'c'.repeat(64), name: 'Sticker', token: `sticker:https://chat.test/api/stickers/assets/${'c'.repeat(64)}.webp` };
  const toast = vi.fn();

  beforeEach(() => {
    vi.useRealTimers();
    toast.mockReset();
    useUIStore.setState({ addToast: toast });
    useContextMenuStore.getState().close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function openMenu(token: string) {
    cleanup();
    render(<ReactionPill emoji={token} origin="" reactions={[{ ...reaction(MIRA, 1), emoji: token }]} onToggle={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole('button'), { clientX: 100, clientY: 200 });
    const menu = useContextMenuStore.getState().menu;
    if (!menu) throw new Error('Expected a menu');
    return menu;
  }

  async function runCollect(token: string) {
    const item = openMenu(token).items.find(i => i.key === 'collect-sticker');
    if (item?.type !== 'action') throw new Error('Expected the collect action');
    await item.onClick();
  }

  it('offers the image menu a sticker message gets', () => {
    const menu = openMenu(remoteToken);
    expect(menu.position).toEqual({ x: 100, y: 200 });
    expect(menu.items.map(i => i.key)).toEqual(['collect-sticker', 'favorite-sticker', 'save-image', 'copy-image', 'image-sep']);
  });

  it('collects a sticker from this instance by reference', async () => {
    const collect = vi.spyOn(api.stickers, 'collect').mockResolvedValue(saved);
    const fetchImage = vi.fn();
    vi.stubGlobal('fetch', fetchImage);
    await runCollect(remoteToken);
    expect(collect).toHaveBeenCalledWith({ id: ID, token: remoteToken, name: 'Sticker' });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(toast).toHaveBeenLastCalledWith('Added to my stickers', 'success');
  });

  it('reads another instance\'s sticker from its own address and uploads it home', async () => {
    vi.spyOn(api.stickers, 'collect').mockRejectedValue(new HttpError(400, 'not local', undefined, 'sticker_not_local'));
    const upload = vi.spyOn(api.stickers, 'upload').mockResolvedValue(saved);
    const fetchImage = vi.fn().mockResolvedValue(new Response('webp', { headers: { 'Content-Type': 'image/webp' } }));
    vi.stubGlobal('fetch', fetchImage);
    await runCollect(remoteToken);
    expect(fetchImage).toHaveBeenCalledWith(`https://remote.test/api/stickers/assets/${ID}.webp`, { credentials: 'omit', cache: 'no-store' });
    expect(upload).toHaveBeenCalledWith({ name: 'Sticker', image: btoa('webp') });
    expect(toast).toHaveBeenLastCalledWith('Added to my stickers', 'success');
  });

  it('names the reason when the other instance cannot be read or the home instance refuses', async () => {
    vi.spyOn(api.stickers, 'collect').mockRejectedValue(new HttpError(400, 'not local', undefined, 'sticker_not_local'));
    const upload = vi.spyOn(api.stickers, 'upload');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await runCollect(remoteToken);
    expect(toast).toHaveBeenLastCalledWith('The image could not be loaded.', 'warning');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } })));
    await runCollect(remoteToken);
    expect(toast).toHaveBeenLastCalledWith('The image could not be loaded.', 'warning');
    expect(upload).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('webp', { headers: { 'Content-Type': 'image/webp' } })));
    upload.mockRejectedValue(new HttpError(409, 'full', undefined, 'sticker_collection_full', { max: 200 }));
    await runCollect(remoteToken);
    expect(toast).toHaveBeenLastCalledWith('Your collection is full at 200 stickers. Remove one to add another.', 'warning');
  });

  it('leaves an emoji pill to the message menu', () => {
    const outer = vi.fn();
    render(<div onContextMenu={outer}><ReactionPill emoji="🎉" origin="" reactions={[reaction(MIRA, 1)]} onToggle={vi.fn()} /></div>);
    fireEvent.contextMenu(screen.getByRole('button'));
    expect(useContextMenuStore.getState().menu).toBeNull();
    expect(outer).toHaveBeenCalledOnce();
  });
});
