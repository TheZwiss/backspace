import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom.
// Reached transitively via spaceStore → chatStore → useWebSocket → voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

// Mock the API client so we can assert spaceInvite calls.
const mockSpaceInvite = vi.fn();
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  api: {
    dm: {
      spaceInvite: (...args: unknown[]) => mockSpaceInvite(...args),
    },
  },
}));

import { InviteFriendModal } from './InviteFriendModal';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';

function makeFriend(overrides: Partial<any> = {}) {
  return {
    id: 'f1',
    username: 'alex',
    displayName: 'Alex',
    avatar: null,
    avatarColor: null,
    status: 'online' as const,
    createdAt: 0,
    homeUserId: null,
    homeInstance: null,
    replicatedInstances: [],
    _instanceOrigin: '',
    ...overrides,
  };
}

function makeSpace(overrides: Partial<any> = {}) {
  return {
    id: 'space-1',
    name: 'My Space',
    icon: null,
    avatarColor: null,
    ownerId: 'owner-1',
    visibility: 'private',
    createdAt: 0,
    _instanceOrigin: '',
    ...overrides,
  };
}

function setUp({
  friend = makeFriend(),
  spaces = [makeSpace()],
  generateInvite = vi.fn().mockResolvedValue('test-code'),
}: {
  friend?: any;
  spaces?: any[];
  generateInvite?: ReturnType<typeof vi.fn>;
} = {}) {
  useUIStore.setState({ activeModal: 'inviteFriend', modalData: { friend } });
  useSpaceStore.setState({ spaces, generateInvite } as any);
  useAuthStore.setState({ user: { id: 'me', username: 'me' } } as any);
  return { generateInvite };
}

beforeEach(() => {
  mockSpaceInvite.mockReset();
  useUIStore.setState({ activeModal: null, modalData: {} });
  useSpaceStore.setState({ spaces: [] } as any);
  useAuthStore.setState({ user: null } as any);
});

describe('InviteFriendModal', () => {
  it('does not render when a different modal is active', () => {
    useUIStore.setState({ activeModal: 'invite', modalData: {} });
    render(<InviteFriendModal />);
    expect(screen.queryByText('My Space')).not.toBeInTheDocument();
  });

  it('lists the user\'s spaces under a friend-named title', () => {
    setUp();
    render(<InviteFriendModal />);
    expect(screen.getByText('Invite Alex to a Space')).toBeInTheDocument();
    expect(screen.getByText('My Space')).toBeInTheDocument();
  });

  it('clicking a space generates its invite and sends it to the friend', async () => {
    const user = userEvent.setup();
    mockSpaceInvite.mockResolvedValue({});
    const { generateInvite } = setUp({
      spaces: [makeSpace({ id: 'space-1', name: 'My Space' })],
    });

    render(<InviteFriendModal />);
    await user.click(screen.getByText('My Space'));

    await waitFor(() => expect(mockSpaceInvite).toHaveBeenCalledTimes(1));
    expect(generateInvite).toHaveBeenCalledWith('space-1');
    expect(mockSpaceInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'space-1',
        inviteCode: 'test-code',
        target: { userId: 'f1' },
      }),
    );
    expect(await screen.findByText('✓ Sent')).toBeInTheDocument();
  });

  it('surfaces a per-row reason when the send fails', async () => {
    const user = userEvent.setup();
    const { HttpError } = await import('../../api/client');
    mockSpaceInvite.mockRejectedValue(
      new HttpError(400, 'Not a friend', { error: 'Not a friend', code: 'not_a_friend', statusCode: 400 }, 'not_a_friend'),
    );
    setUp();

    render(<InviteFriendModal />);
    await user.click(screen.getByText('My Space'));

    expect(await screen.findByText('Not a friend')).toBeInTheDocument();
  });

  it('shows an empty state when the user has no spaces', () => {
    setUp({ spaces: [] });
    render(<InviteFriendModal />);
    expect(screen.getByText('You’re not in any Spaces yet')).toBeInTheDocument();
  });
});
