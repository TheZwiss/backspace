import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MemberWithUser, User } from '@backspace/shared';

// Stub AudioManager to avoid an AudioWorkletNode reference error in jsdom.
// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { OverviewPanel } from './OverviewPanel';
import { useSpaceStore, type TaggedSpace } from '../../../stores/spaceStore';
import { useAuthStore } from '../../../stores/authStore';

const owner: User = {
  id: 'user-1',
  username: 'owner',
  displayName: 'Owner',
  avatar: null,
  banner: null,
  accentColor: null,
  avatarColor: 'lavender',
  bio: null,
  status: 'online',
  customStatus: null,
  isAdmin: false,
  createdAt: 1,
  homeInstance: null,
  homeUserId: null,
  replicatedInstances: [],
};

const other: User = { ...owner, id: 'user-2', username: 'member', displayName: 'Member' };

function member(user: User): MemberWithUser {
  return { spaceId: 'space-1', userId: user.id, nickname: null, joinedAt: 1, user, roles: [] };
}

const space: TaggedSpace = {
  id: 'space-1',
  name: 'Aether Drift',
  icon: null,
  banner: null,
  avatarColor: 'lavender',
  ownerId: 'user-1',
  inviteCode: null,
  visibility: 'public',
  directoryListed: false,
  description: '',
  createdAt: 1,
  _instanceOrigin: '',
};

beforeEach(() => {
  useSpaceStore.setState({
    spaces: [space],
    members: [member(owner), member(other)],
    spacePermissions: new Map([['space-1', '-1']]),
  });
  useAuthStore.setState({ user: owner });
});

function renderPanel(): void {
  render(
    <MemoryRouter>
      <OverviewPanel spaceId="space-1" />
    </MemoryRouter>,
  );
}

/**
 * The panel guards on `if (!space) return null`, and that guard is reachable
 * while the panel stays mounted: the WebSocket handler calls removeSpace on
 * `member_banned`, and removeInstanceSpaces drops an instance's spaces when its
 * connection goes away. Neither closes the settings modal. While a hook sat
 * below the guard, that re-render called fewer hooks than the previous one and
 * React threw "Rendered fewer hooks than expected".
 */
describe('OverviewPanel when the space leaves the store', () => {
  it('survives removeSpace while it is mounted', () => {
    renderPanel();
    expect(screen.getByDisplayValue('Aether Drift')).toBeInTheDocument();

    expect(() => {
      act(() => {
        useSpaceStore.getState().removeSpace('space-1');
      });
    }).not.toThrow();

    expect(screen.queryByDisplayValue('Aether Drift')).not.toBeInTheDocument();
  });

  it('survives removeInstanceSpaces while it is mounted', () => {
    renderPanel();
    expect(screen.getByDisplayValue('Aether Drift')).toBeInTheDocument();

    expect(() => {
      act(() => {
        useSpaceStore.getState().removeInstanceSpaces('');
      });
    }).not.toThrow();

    expect(screen.queryByDisplayValue('Aether Drift')).not.toBeInTheDocument();
  });
});
