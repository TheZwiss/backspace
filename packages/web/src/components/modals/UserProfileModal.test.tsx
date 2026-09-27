import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@backspace/shared';

// The modal reaches into the space store (origin routing, DM lookup) and the
// federated-mutuals loader. None of that is under test here:
// stub it so the test exercises what the About tab renders.
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ addDmChannel: vi.fn(), findExistingDmForUser: vi.fn(), upsertUserView: vi.fn() }),
    { getState: () => ({ addDmChannel: vi.fn(), findExistingDmForUser: vi.fn(), upsertUserView: vi.fn() }) },
  ),
  getApiForOrigin: () => ({ uploads: { url: (k: string) => `/uploads/${k}` }, users: { get: vi.fn() } }),
  resolveUserOrigin: () => 'local',
}));
// authStore imports voiceStore, which imports AudioManager and with it an
// AudioWorklet module jsdom cannot evaluate.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
vi.mock('../../utils/mutuals', () => ({
  loadFederatedMutuals: vi.fn().mockResolvedValue({ mutualFriends: [], mutualSpaces: [] }),
}));

import { UserProfileModal } from './UserProfileModal';
import { useUIStore } from '../../stores/uiStore';

function makeUser(overrides: Partial<User>): User {
  return {
    id: 'u-1', username: 'james', displayName: 'James', avatar: null, banner: null,
    accentColor: null, avatarColor: null, bio: null, status: 'online',
    customStatus: null, isAdmin: false, createdAt: 0, homeInstance: null,
    homeUserId: null, replicatedInstances: [],
    ...overrides,
  };
}

describe('UserProfileModal', () => {
  beforeEach(() => {
    useUIStore.setState({ activeModal: null, modalData: {} });
  });

  it('renders emoji shortcodes in the bio and custom status as emoji (issue #252)', () => {
    const user = makeUser({
      customStatus: 'praying :pray:',
      bio: 'Christus aeternus est. :heart_on_fire:',
    });
    useUIStore.getState().openModal('userProfile', { userId: user.id, user, origin: '' });

    render(
      <MemoryRouter>
        <UserProfileModal />
      </MemoryRouter>,
    );

    expect(screen.getByText('praying 🙏')).toBeInTheDocument();
    expect(screen.getByText('Christus aeternus est. ❤️‍🔥')).toBeInTheDocument();
  });
});
