import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
  render(<ReactionPill emoji="🎉" reactions={reactions} onToggle={onToggle} />);
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
