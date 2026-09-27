import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));
vi.mock('../../utils/mutuals', () => ({
  loadFederatedMutuals: vi.fn().mockResolvedValue({ mutualFriends: [], mutualSpaces: [] }),
}));
const usersGet = vi.fn();
vi.mock('../../utils/crossStoreResolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crossStoreResolvers')>()),
  getApiForOrigin: () => ({
    users: { get: (...args: unknown[]) => usersGet(...args) },
    uploads: { url: (k: string) => `/uploads/${k}` },
  }),
}));

import { UserProfileModal } from './UserProfileModal';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';

// #302: the full profile lists the member's roles in the space it was opened
// from. On mobile it is opened with ids only, so it takes the member's user
// from the space it came from rather than looking the id up on the home
// instance, where a federated space's member id means nothing.

const SPACE_ID = 'space-1';
const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender',
  ownerId: 'u-owner', inviteCode: null, visibility: 'public', directoryListed: false,
  description: '', createdAt: 1, _instanceOrigin: 'https://orbit.example',
};

const MIRA: User = {
  id: 'orbit-mira', username: 'mira', displayName: 'Mira', avatar: null, banner: null,
  accentColor: null, avatarColor: null, bio: null, status: 'offline', customStatus: null,
  isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: [],
};

const MODS: Role = { id: 'r-mod', spaceId: SPACE_ID, name: 'Moderators', color: '#c4b5fd', position: 3, createdAt: 1 };

const MEMBER: MemberWithUser = {
  spaceId: SPACE_ID, userId: MIRA.id, nickname: null, joinedAt: 1, user: MIRA, roles: [MODS],
};

beforeEach(() => {
  usersGet.mockReset();
  useSpaceStore.setState({ spaces: [SPACE], currentSpaceId: SPACE_ID, members: [MEMBER] });
});

describe('UserProfileModal: roles (#302)', () => {
  it('lists the member\'s roles when opened with ids only, without asking the home instance', async () => {
    useUIStore.setState({
      activeModal: 'userProfile',
      modalData: { userId: MIRA.id, member: { spaceId: SPACE_ID, userId: MIRA.id } },
    });
    render(<MemoryRouter><UserProfileModal /></MemoryRouter>);

    const list = await screen.findByRole('list', { name: 'Roles' });
    expect(within(list).getByText('Moderators')).toBeInTheDocument();
    expect(usersGet).not.toHaveBeenCalled();
  });

  it('has no roles section without a member context', async () => {
    useUIStore.setState({ activeModal: 'userProfile', modalData: { userId: MIRA.id, user: MIRA, origin: '' } });
    render(<MemoryRouter><UserProfileModal /></MemoryRouter>);
    expect(await screen.findAllByText('Mira')).not.toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'Roles' })).toBeNull();
  });
});
