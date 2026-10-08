import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@backspace/shared';

// The card reaches into the space store, the API client and the federated
// mutuals loader. None of that is under test here; stub it so the test sees
// only where the card lands in the document.
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ upsertDmCopy: vi.fn(), findExistingDmForUser: vi.fn() }),
    { getState: () => ({ upsertDmCopy: vi.fn(), findExistingDmForUser: vi.fn() }) },
  ),
  getApiForOrigin: () => ({ uploads: { url: (k: string) => `/uploads/${k}` } }),
}));
// authStore imports voiceStore, which imports AudioManager and with it an
// AudioWorklet module jsdom cannot evaluate.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
vi.mock('../../utils/mutuals', () => ({
  loadFederatedMutuals: vi.fn().mockResolvedValue({ mutualFriends: [], mutualSpaces: [] }),
}));
vi.mock('../../utils/userViewLookup', () => ({ useCanonicalUserView: (u: User) => u }));
vi.mock('../../hooks/useShownStatus', () => ({ useShownStatus: (_u: User, _origin: string, status: User['status']) => status }));

import { Modal } from './Modal';
import { UserProfilePopoutLayer } from './UserProfilePopoutLayer';
import { useUIStore } from '../../stores/uiStore';

const ADA: User = {
  id: 'u-1', username: 'ada', displayName: 'Ada', avatar: null, banner: null,
  accentColor: null, avatarColor: null, bio: null, status: 'online',
  customStatus: null, isAdmin: false, createdAt: 0, homeInstance: null,
  homeUserId: null, replicatedInstances: [],
};
const ANCHOR = { top: 200, left: 200, right: 240, bottom: 240, width: 40, height: 40 };

function MembersDialog() {
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  return (
    <Modal isOpen onClose={() => {}} title="Group settings">
      <button type="button" onClick={() => openUserProfile(ADA, '', ANCHOR)}>Ada</button>
    </Modal>
  );
}

beforeEach(() => {
  useUIStore.setState({ isMobile: false });
  useUIStore.getState().closeUserProfile();
});

describe('UserProfilePopoutLayer', () => {
  it('draws the card opened from inside an open Modal above that dialog', () => {
    // Mirrors AppLayout: the dialog and the layer both sit in the app root.
    render(
      <MemoryRouter>
        <div data-testid="app-root">
          <MembersDialog />
          <UserProfilePopoutLayer />
        </div>
      </MemoryRouter>,
    );
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Ada' })); });

    const dialog = screen.getByRole('heading', { name: 'Group settings' }).closest('.fixed');
    const card = document.querySelector('[data-user-profile-popout]');
    expect(dialog).toBeInstanceOf(HTMLElement);
    expect(card).toBeInstanceOf(HTMLElement);
    if (!(dialog instanceof HTMLElement) || !(card instanceof HTMLElement)) return;

    expect(screen.getByTestId('app-root')).not.toContainElement(card);
    expect(card.parentElement).toBe(document.body);
    // Same z-index, so the later element in the document draws on top.
    expect(dialog).toHaveClass('z-[200]');
    expect(card).toHaveClass('z-[200]');
    expect(dialog.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('closes the card on a click on its backdrop', () => {
    render(
      <MemoryRouter>
        <UserProfilePopoutLayer />
      </MemoryRouter>,
    );
    act(() => { useUIStore.getState().openUserProfile(ADA, '', ANCHOR); });
    const backdrop = document.querySelector('body > .fixed.inset-0.z-\\[145\\]');
    expect(backdrop).toBeInstanceOf(HTMLElement);
    if (!(backdrop instanceof HTMLElement)) return;
    fireEvent.click(backdrop);
    expect(useUIStore.getState().userProfilePopout.user).toBeNull();
    expect(document.querySelector('[data-user-profile-popout]')).toBeNull();
  });

  it('renders nothing while no profile is open', () => {
    render(
      <MemoryRouter>
        <UserProfilePopoutLayer />
      </MemoryRouter>,
    );
    expect(document.querySelector('[data-user-profile-popout]')).toBeNull();
  });
});
