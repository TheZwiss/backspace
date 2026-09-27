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

import { UserProfilePopout } from './UserProfilePopout';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';

// #302: the profile card lists the member's roles in the space it was opened
// from, whatever their presence.

const SPACE_ID = 'space-1';
const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender',
  ownerId: 'u-owner', inviteCode: null, visibility: 'public', directoryListed: false,
  description: '', createdAt: 1, _instanceOrigin: '',
};

function role(id: string, name: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name, color: '#c4b5fd', position, createdAt: 1 };
}

// A member whose home is another instance: the space's instance knows them by
// a local replicated id, which is the id the member row and the context carry.
const MIRA: User = {
  id: 'local-mira', username: 'mira@orbit.example', displayName: 'Mira', avatar: null, banner: null,
  accentColor: null, avatarColor: null, bio: null, status: 'offline', customStatus: null,
  isAdmin: false, createdAt: 1, homeInstance: 'orbit.example', homeUserId: 'home-mira',
  replicatedInstances: [],
};

const MEMBER: MemberWithUser = {
  spaceId: SPACE_ID, userId: MIRA.id, nickname: null, joinedAt: 1, user: MIRA,
  roles: [role('r-guest', 'Guests', 1), role('r-mod', 'Moderators', 3)],
};

const anchor = { top: 100, left: 100, right: 140, bottom: 140, width: 40, height: 40 };

beforeEach(() => {
  useSpaceStore.setState({ spaces: [SPACE], currentSpaceId: SPACE_ID, members: [MEMBER] });
});

function renderCard(member: { spaceId: string; userId: string } | null) {
  render(
    <MemoryRouter>
      <UserProfilePopout user={MIRA} member={member} onClose={() => {}} anchor={anchor} />
    </MemoryRouter>,
  );
}

describe('UserProfilePopout: roles (#302)', () => {
  it('lists the roles of an offline member, highest first', () => {
    renderCard({ spaceId: SPACE_ID, userId: MIRA.id });
    const list = screen.getByRole('list', { name: 'Roles' });
    const items = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Moderators', 'Guests']);
  });

  it('shows no roles section when the card was not opened from a space', () => {
    renderCard(null);
    expect(screen.queryByRole('list', { name: 'Roles' })).toBeNull();
  });

  it('shows no roles section when that space is not the one loaded', () => {
    useSpaceStore.setState({ currentSpaceId: 'space-2' });
    renderCard({ spaceId: SPACE_ID, userId: MIRA.id });
    expect(screen.queryByRole('list', { name: 'Roles' })).toBeNull();
  });
});
