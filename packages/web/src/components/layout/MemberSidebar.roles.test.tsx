import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MemberWithUser, Role, User } from '@backspace/shared';

// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }),
  },
}));

import { MemberSidebar } from './MemberSidebar';
import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';

// #302: a member's roles are theirs whether or not they are connected. The
// member list keeps showing them for offline members, and the profile it
// opens knows which space member it is about.

const SPACE_ID = 'space-1';

const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender',
  ownerId: 'u-owner', inviteCode: null, visibility: 'public', directoryListed: false,
  description: '', createdAt: 1, _instanceOrigin: '',
};

const MODS: Role = { id: 'r-mod', spaceId: SPACE_ID, name: 'Moderators', color: '#c4b5fd', position: 2, createdAt: 1 };

function user(id: string, name: string, status: User['status']): User {
  return {
    id, username: name.toLowerCase(), displayName: name, avatar: null, banner: null, accentColor: null,
    avatarColor: null, bio: null, status, customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

function member(u: User, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: u.id, nickname: null, joinedAt: 1, user: u, roles };
}

beforeEach(() => {
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    loadingSpaceId: null,
    members: [
      member(user('u-owner', 'Jannis', 'online'), []),
      member(user('u-mira', 'Mira', 'offline'), [MODS]),
    ],
  });
  useUIStore.setState({
    isMobile: false,
    memberListOpen: true,
    userProfilePopout: { user: null, anchor: null, placement: 'right', member: null },
  });
});

describe('MemberSidebar: roles of offline members (#302)', () => {
  it('colours an offline member by their top role', () => {
    render(<MemberSidebar />);
    const name = screen.getByText('Mira');
    expect(name).toHaveStyle({ color: '#c4b5fd' });
  });

  it('opens the profile with the space member it was opened for', async () => {
    render(<MemberSidebar />);
    await userEvent.click(screen.getByText('Mira'));
    const popout = useUIStore.getState().userProfilePopout;
    expect(popout.user?.id).toBe('u-mira');
    expect(popout.member).toEqual({ spaceId: SPACE_ID, userId: 'u-mira' });
  });

  it('carries the member into the mobile profile screen', () => {
    useUIStore.setState({ isMobile: true, mobileStack: [] });
    const mira = useSpaceStore.getState().members[1]!;
    useUIStore.getState().openUserProfile(mira.user, '', { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }, 'left', { spaceId: SPACE_ID, userId: mira.userId });
    expect(useUIStore.getState().mobileStack.at(-1)).toEqual({
      screen: 'user-profile',
      params: { userId: 'u-mira', origin: '', spaceId: SPACE_ID, memberUserId: 'u-mira' },
    });
  });
});

describe('MemberSidebar: member names', () => {
  it('names a member with an empty display name by their username, as every other surface does', () => {
    const blank: User = { ...user('u-kai', 'Kai', 'online'), displayName: '' };
    useSpaceStore.setState({ members: [member(blank, [])] });
    render(<MemberSidebar />);
    expect(screen.getByText('kai')).toBeInTheDocument();
  });
});
