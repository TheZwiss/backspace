import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { User } from '@backspace/shared';
import type { HubUpdateState } from '../../stores/projectHubStore';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via authStore -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// The dot's source of truth has its own tests; here only what the You screen
// does with each state matters.
const hubState = vi.hoisted(() => ({ state: 'current' as HubUpdateState }));
vi.mock('../../hooks/useHubUpdateState', () => ({
  useHubUpdateState: () => ({ state: hubState.state, version: '1.2.0' }),
}));

import { fireEvent, render, screen, within } from '@testing-library/react';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { MobileYouScreen } from './MobileYouScreen';

const DOT = 'Backspace was updated';

const self: User = {
  id: 'user-self',
  username: 'me',
  displayName: 'Me',
  avatar: null,
  banner: null,
  accentColor: null,
  avatarColor: null,
  bio: null,
  status: 'online',
  customStatus: null,
  isAdmin: false,
  createdAt: 0,
  homeInstance: null,
  homeUserId: null,
  replicatedInstances: [],
};

const pushMobileScreen = vi.fn();
const originalPush = useUIStore.getState().pushMobileScreen;

/** The action row whose label starts with `label` (a dot adds to the name). */
function row(label: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${label}`) });
}

beforeEach(() => {
  hubState.state = 'current';
  pushMobileScreen.mockReset();
  useUIStore.setState({ pushMobileScreen });
  useAuthStore.setState({ user: self });
});

afterEach(() => {
  useUIStore.setState({ pushMobileScreen: originalPush });
  useAuthStore.setState({ user: null });
});

describe('MobileYouScreen: Backspace row', () => {
  it('renders a Backspace row that pushes the backspace screen', () => {
    render(<MobileYouScreen />);

    fireEvent.click(row('Backspace'));

    expect(pushMobileScreen).toHaveBeenCalledTimes(1);
    expect(pushMobileScreen).toHaveBeenCalledWith('backspace');
  });

  it('shows the updated dot on the Backspace row when the instance updated since the last visit', () => {
    hubState.state = 'updated';

    render(<MobileYouScreen />);

    const dot = screen.getByRole('img', { name: DOT });
    expect(row('Backspace')).toContainElement(dot);
    expect(screen.getAllByRole('img', { name: DOT })).toHaveLength(1);
  });

  it('draws the same informational dot as the desktop sidebar, not the red "needs you" dot', () => {
    hubState.state = 'updated';

    render(<MobileYouScreen />);

    const dot = screen.getByRole('img', { name: DOT });
    expect(dot).toHaveClass('w-2', 'h-2', 'rounded-full', 'bg-accent-primary', 'flex-shrink-0');
    expect(dot).not.toHaveClass('bg-notification');
  });

  it.each<HubUpdateState>(['unknown', 'first-run', 'current'])('shows no dot when the state is %s', (state) => {
    hubState.state = state;

    render(<MobileYouScreen />);

    expect(screen.queryByRole('img', { name: DOT })).toBeNull();
    expect(within(row('Backspace')).queryByRole('img')).toBeNull();
  });

  it('puts the dot on no other row', () => {
    hubState.state = 'updated';

    render(<MobileYouScreen />);

    for (const label of ['Edit Profile', 'Friends', 'Connections', 'Voice']) {
      expect(within(row(label)).queryByRole('img', { name: DOT })).toBeNull();
    }
  });
});
