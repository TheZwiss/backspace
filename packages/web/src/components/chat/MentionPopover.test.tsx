import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@backspace/shared';
import type { ChannelUser } from '../../utils/channelUser';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { useUIStore } from '../../stores/uiStore';
import { MentionPopover } from './MentionPopover';

function makeUser(id: string, username: string, displayName: string | null): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

function candidate(user: User): ChannelUser {
  return { userId: user.id, user, member: null, nameColor: null };
}

function renderPopover(users: User[]): void {
  const anchor = createRef<HTMLElement>();
  render(<MentionPopover candidates={users.map(candidate)} selectedIndex={0} onSelect={() => {}} anchorRef={anchor} />);
}

// jsdom does not implement scrollIntoView; the popover scrolls its selection.
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  useUIStore.setState({ isMobile: false });
});

describe.each([
  ['desktop', false],
  ['mobile', true],
])('MentionPopover rows (%s)', (_label, mobile) => {
  it('keeps the display name whole and lets the username truncate first', () => {
    useUIStore.setState({ isMobile: mobile });
    renderPopover([makeUser('quinn', '1234567890123456789@friend.example', 'Quinn')]);

    const name = screen.getByText('Quinn');
    const username = screen.getByText('@1234567890123456789@friend.example');
    // The name gives up no width while the username has any; it truncates
    // itself only when it alone is wider than the row.
    expect(name).toHaveClass('shrink-0', 'max-w-full', 'truncate');
    expect(username).toHaveClass('min-w-0', 'truncate');
    expect(username).not.toHaveClass('shrink-0');
    // The gap is padding inside the username's clipping box, not a flex gap
    // or margin, so a username squeezed to nothing leaves no gap behind.
    expect(username.parentElement).toHaveClass('min-w-0', 'overflow-hidden');
    expect(name.parentElement?.className).not.toMatch(/\bgap-/);
  });

  it('names a user without a display name by the base of the username and shows the full username beside it', () => {
    useUIStore.setState({ isMobile: mobile });
    renderPopover([makeUser('zed', 'zed@orbit.example', null)]);

    expect(screen.getByText('zed')).toBeInTheDocument();
    expect(screen.getByText('@zed@orbit.example')).toBeInTheDocument();
  });

  it('shows no second line for a local user without a display name', () => {
    useUIStore.setState({ isMobile: mobile });
    renderPopover([makeUser('mira', 'mira', null)]);

    expect(screen.getByText('mira')).toBeInTheDocument();
    expect(screen.queryByText('@mira')).toBeNull();
  });
});
