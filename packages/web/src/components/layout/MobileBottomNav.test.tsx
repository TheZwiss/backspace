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

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { User } from '@backspace/shared';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore, type TaggedFriendRequest } from '../../stores/socialStore';
import { useUIStore } from '../../stores/uiStore';
import { MobileBottomNav } from './MobileBottomNav';
import { setLanguage } from '../../i18n';

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

afterEach(async () => {
  cleanup();
  await setLanguage('en');
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

describe('MobileBottomNav: You tab dot for friend requests', () => {
  const ORBIT = 'https://orbit.example';
  const me = { id: 'n-1', username: 'jannis', displayName: null, homeInstance: null, homeUserId: null } as unknown as User;

  function request(fromId: string, toId: string, other: User, origin: string): TaggedFriendRequest {
    return { id: `r-${fromId}-${toId}`, fromId, toId, status: 'pending', createdAt: 1, user: other, _instanceOrigin: origin };
  }

  it("stays dark for a request the user sent, as another instance lists it", () => {
    // orbit knows the user as o-7 and lists their request to orbit's Bob.
    useAuthStore.setState({ user: me });
    const bob = { id: 'o-2', username: 'bob', displayName: null } as unknown as User;
    useSocialStore.setState({ requests: [request('o-7', 'o-2', bob, ORBIT)] });

    renderNav();

    expect(youDot()).toBeNull();
  });

  it("lights for a request sent to the user on another instance by someone who has the session row's id there", () => {
    useAuthStore.setState({ user: me });
    const cleo = { id: 'n-1', username: 'cleo', displayName: null } as unknown as User;
    useSocialStore.setState({ requests: [request('n-1', 'o-7', cleo, ORBIT)] });

    renderNav();

    expect(youDot()).not.toBeNull();
  });

  it('tells incoming from outgoing on the page instance', () => {
    useAuthStore.setState({ user: me });
    const bob = { id: 'n-2', username: 'bob', displayName: null } as unknown as User;
    useSocialStore.setState({ requests: [request('n-1', 'n-2', bob, '')] });
    const { unmount } = renderNav();
    expect(youDot()).toBeNull();
    unmount();

    useSocialStore.setState({ requests: [request('n-2', 'n-1', bob, '')] });
    renderNav();
    expect(youDot()).not.toBeNull();
  });
});

describe('MobileBottomNav localization', () => {
  it.each([
    { language: 'en', labels: ['Spaces', 'DMs', 'You'] },
    { language: 'de', labels: ['Räume', 'Direktnachrichten', 'Du'] },
    { language: 'ru', labels: ['Пространства', 'Личные сообщения', 'Вы'] },
    { language: 'zh', labels: ['空间', '私信', '我'] },
    { language: 'pt', labels: ['Espaços', 'Mensagens diretas', 'Você'] },
  ] as const)('renders all tabs in $language', async ({ language, labels }) => {
    await setLanguage(language);
    renderNav();

    for (const label of labels) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('updates mounted tabs on language changes without changing tab behavior', async () => {
    renderNav();
    await act(() => setLanguage('zh'));

    expect(screen.queryByRole('button', { name: 'You' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '我' }));
    expect(useUIStore.getState().mobileScreen).toBe('you');
    fireEvent.click(screen.getByRole('button', { name: '私信' }));
    expect(useUIStore.getState().mobileScreen).toBe('dms');
  });
});
