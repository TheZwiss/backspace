import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@backspace/shared';

// The popout reaches into the space store (origin routing), the API client and
// the federated-mutuals loader. None of that is under test here — stub it so the
// test exercises the card's own click and placement behaviour.
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ addDmChannel: vi.fn(), findExistingDmForUser: vi.fn() }),
    { getState: () => ({ addDmChannel: vi.fn(), findExistingDmForUser: vi.fn() }) },
  ),
  getApiForOrigin: () => ({ uploads: { url: (k: string) => `/uploads/${k}` } }),
  resolveUserOrigin: () => 'local',
}));
vi.mock('../../api/client', () => ({ api: { dm: { create: vi.fn() } } }));
vi.mock('../../utils/mutuals', () => ({
  loadFederatedMutuals: vi.fn().mockResolvedValue({ mutualFriends: [], mutualSpaces: [] }),
}));
vi.mock('../../utils/userViewLookup', () => ({ useCanonicalUserView: (u: User) => u }));

import { UserProfilePopout } from './UserProfilePopout';
import { useUIStore } from '../../stores/uiStore';

const CARD_W = 340;
const CARD_H = 420;

function makeUser(): User {
  return {
    id: 'u-1', username: 'ada', displayName: 'Ada', avatar: null, banner: null,
    accentColor: null, avatarColor: null, bio: null, status: 'online',
    customStatus: null, isAdmin: false, createdAt: 0, homeInstance: null,
    homeUserId: null, replicatedInstances: [],
  };
}

function anchorAt(left: number, top: number, size = 40) {
  return { top, left, right: left + size, bottom: top + size, width: size, height: size };
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

function renderCard(anchor: ReturnType<typeof anchorAt>, placement?: 'left' | 'right') {
  return render(
    <MemoryRouter>
      <UserProfilePopout user={makeUser()} onClose={() => {}} anchor={anchor} placement={placement} />
    </MemoryRouter>,
  );
}

describe('UserProfilePopout', () => {
  beforeEach(() => {
    setViewport(1920, 1080);
    useUIStore.setState({
      isMobile: false,
      activeModal: null,
      modalData: {},
      userProfilePopout: { user: null, anchor: null, placement: 'right' },
    });
    // jsdom has no layout: give every element the card's real measured size so
    // the popout can place itself off its own dimensions.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0, left: 0, right: CARD_W, bottom: CARD_H, width: CARD_W, height: CARD_H,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
  });

  it('does not reopen itself when its own picture is clicked (issue #37)', async () => {
    const { container } = renderCard(anchorAt(300, 200));

    const avatar = container.querySelector('[data-avatar]')!;
    await userEvent.click(avatar);
    await userEvent.click(avatar);

    expect(useUIStore.getState().userProfilePopout.user).toBeNull();
  });

  it("escalates to the full profile when the card's picture is clicked", async () => {
    // The picture is the obvious thing to click for "show me more about this
    // person". Doing nothing there is a dead end — the only way forward would be
    // the View Full Profile link.
    let closed = false;
    const { container } = render(
      <MemoryRouter>
        <UserProfilePopout user={makeUser()} onClose={() => { closed = true; }} anchor={anchorAt(300, 200)} />
      </MemoryRouter>,
    );

    await userEvent.click(container.querySelector('[data-avatar]')!);

    expect(useUIStore.getState().activeModal).toBe('userProfile');
    expect(useUIStore.getState().modalData).toMatchObject({ userId: 'u-1' });
    expect(closed).toBe(true);
  });

  it('sits beside its anchor', () => {
    const { container } = renderCard(anchorAt(300, 200));

    const card = container.querySelector('[data-user-profile-popout]') as HTMLElement;
    expect(parseFloat(card.style.left)).toBe(340 + 8); // anchor.right + offset
    expect(parseFloat(card.style.top)).toBe(200); // top-aligned with its anchor
  });

  it('flips to the other side instead of running off the right edge', () => {
    setViewport(1000, 800);
    const { container } = renderCard(anchorAt(900, 100));

    const card = container.querySelector('[data-user-profile-popout]') as HTMLElement;
    const left = parseFloat(card.style.left);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + CARD_W).toBeLessThanOrEqual(1000 - 8);
  });

  it('keeps a tall card on screen when anchored near the bottom', () => {
    setViewport(1280, 700);
    const { container } = renderCard(anchorAt(200, 660));

    const card = container.querySelector('[data-user-profile-popout]') as HTMLElement;
    const top = parseFloat(card.style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + CARD_H).toBeLessThanOrEqual(700 - 8);
  });
});
