import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HubUpdateState } from '../../stores/projectHubStore';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Both dot sources have their own tests; here only how the tab combines them.
const sources = vi.hoisted(() => ({ hub: 'current' as HubUpdateState, instanceUpdate: false }));
vi.mock('../../hooks/useHubUpdateState', () => ({
  useHubUpdateState: () => ({ state: sources.hub, version: '1.2.0' }),
}));
vi.mock('../../hooks/useInstanceUpdateBadge', () => ({
  useInstanceUpdateBadge: () => sources.instanceUpdate,
}));

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { useUIStore } from '../../stores/uiStore';
import { MobileBottomNav } from './MobileBottomNav';

function renderNav() {
  return render(
    <MemoryRouter initialEntries={['/channels/@me']}>
      <MobileBottomNav />
    </MemoryRouter>,
  );
}

/** The You tab's dot, or null when the tab shows none. */
function youDot(): Element | null {
  return screen.getByRole('button', { name: 'You' }).querySelector('.bg-notification');
}

beforeEach(() => {
  sources.hub = 'current';
  sources.instanceUpdate = false;
  useUIStore.setState({ mobileScreen: 'spaces', mobileStack: [] });
  useSocialStore.setState({ requests: [] });
  useAuthStore.setState({ user: null });
});

afterEach(() => {
  useUIStore.setState({ mobileScreen: 'spaces', mobileStack: [] });
});

describe('MobileBottomNav: You tab dot', () => {
  it('lights on a hub update alone', () => {
    sources.hub = 'updated';

    renderNav();

    expect(youDot()).not.toBeNull();
  });

  it.each<HubUpdateState>(['unknown', 'first-run', 'current'])('stays dark when the hub state is %s and nothing else is pending', (state) => {
    sources.hub = state;

    renderNav();

    expect(youDot()).toBeNull();
  });

  it('still lights on an instance update with the hub current', () => {
    sources.instanceUpdate = true;

    renderNav();

    expect(youDot()).not.toBeNull();
  });
});
