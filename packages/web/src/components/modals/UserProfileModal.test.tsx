import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@backspace/shared';

// The modal reaches into the space store (origin routing, DM lookup) and the
// federated-mutuals loader. None of that is under test here:
// stub it so the test exercises what the About tab renders.
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ upsertDmCopy: vi.fn(), findExistingDmForUser: vi.fn(), upsertUserView: vi.fn() }),
    { getState: () => ({ upsertDmCopy: vi.fn(), findExistingDmForUser: vi.fn(), upsertUserView: vi.fn() }) },
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
import { useSocialStore } from '../../stores/socialStore';
import { api, HttpError } from '../../api/client';

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

  it('Add Friend on a federated user sends their home identity, not only the stub username (issue #339)', async () => {
    // A stub minted without a name hint is called <homeUserId>@<domain>; the
    // peer cannot find anyone by that name.
    const stub = makeUser({
      id: 'stub-local-id',
      username: '342939417492520960@orbit.test',
      displayName: 'Yoko',
      homeUserId: '342939417492520960',
      homeInstance: 'orbit.test',
    });
    const sendFriendRequest = vi.fn().mockResolvedValue('req-1');
    useSocialStore.setState({ friends: [], requests: [], sendFriendRequest });
    useUIStore.getState().openModal('userProfile', { userId: stub.id, user: stub, origin: '' });

    render(
      <MemoryRouter>
        <UserProfileModal />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Add Friend'));

    await waitFor(() => expect(sendFriendRequest).toHaveBeenCalledOnce());
    expect(sendFriendRequest).toHaveBeenCalledWith({
      username: '342939417492520960@orbit.test',
      homeUserId: '342939417492520960',
      homeInstance: 'orbit.test',
    });
  });

  it('tells the user why Send Message failed', async () => {
    const create = vi.spyOn(api.dm, 'create').mockRejectedValueOnce(new HttpError(404, 'User not found', null, 'user_not_found'));
    const addToast = vi.fn();
    useUIStore.setState({ addToast });
    const user = makeUser({});
    useUIStore.getState().openModal('userProfile', { userId: user.id, user, origin: '' });

    render(
      <MemoryRouter>
        <UserProfileModal />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Send Message'));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Could not open the conversation: No user with that name was found.', 'warning'));
    expect(useUIStore.getState().activeModal).toBe('userProfile');
    create.mockRestore();
  });
});
