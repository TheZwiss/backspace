import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  // Keep the real exports (HttpError is what describeError inspects) and
  // replace only the api surface this test asserts on.
  ...(await importOriginal<typeof import('../../api/client')>()),
  api: {
    dm: {
      spaceInvite: (...args: unknown[]) => mockSpaceInvite(...args),
    },
  },
}));

import { InviteModal } from './InviteModal';
import { HttpError } from '../../api/client';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useSocialStore } from '../../stores/socialStore';
import { useAuthStore } from '../../stores/authStore';
import { useInstanceStore, type ConnectedInstance } from '../../stores/instanceStore';

// Helpers — minimal fixtures for store state.
function makeFriend(overrides: Partial<any> = {}) {
  return {
    id: 'friend-1',
    username: 'alex',
    displayName: 'Alex',
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online' as const,
    customStatus: null,
    createdAt: 0,
    addedAt: 0,
    homeUserId: null,
    homeInstance: null,
    _instanceOrigin: '',
    ...overrides,
  };
}

function makeMember(overrides: Partial<any> = {}) {
  return {
    spaceId: 'space-1',
    userId: 'member-1',
    nickname: null,
    joinedAt: 0,
    roles: [],
    user: {
      id: 'member-1',
      username: 'memberA',
      displayName: null,
      avatar: null,
      banner: null,
      accentColor: null,
      avatarColor: null,
      bio: null,
      status: 'offline',
      customStatus: null,
      isAdmin: false,
      createdAt: 0,
      homeInstance: null,
      homeUserId: null,
      replicatedInstances: [],
      ...(overrides.user ?? {}),
    },
    ...overrides,
  };
}

function makeSpace(overrides: Partial<any> = {}) {
  return {
    id: 'space-1',
    name: 'Test Space',
    icon: null,
    avatarColor: null,
    description: null,
    ownerId: 'owner-1',
    public: false,
    discoverable: false,
    joinPolicy: 'invite',
    createdAt: 0,
    _instanceOrigin: '',
    ...overrides,
  };
}

function setUpStore({
  friends = [],
  members = [],
  myUser = { id: 'me', username: 'me' } as any,
  generateInvite = vi.fn().mockResolvedValue('test-code'),
}: {
  friends?: any[];
  members?: any[];
  myUser?: any;
  generateInvite?: ReturnType<typeof vi.fn>;
} = {}) {
  useUIStore.setState({ activeModal: 'invite', modalData: {} });
  useSpaceStore.setState({
    currentSpaceId: 'space-1',
    spaces: [makeSpace()] as any,
    members,
    generateInvite,
  } as any);
  useSocialStore.setState({ friends } as any);
  useAuthStore.setState({ user: myUser } as any);
  return { generateInvite };
}

beforeEach(() => {
  mockSpaceInvite.mockReset();

  useUIStore.setState({ activeModal: null, modalData: {} });
  useSpaceStore.setState({
    currentSpaceId: null,
    spaces: [],
    members: [],
  } as any);
  useSocialStore.setState({ friends: [] } as any);
  useAuthStore.setState({ user: null } as any);

  // Mock clipboard.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

describe('InviteModal', () => {
  it('does not render when activeModal is not "invite"', () => {
    render(<InviteModal />);
    expect(screen.queryByText('Invite Friends')).not.toBeInTheDocument();
  });

  it('renders friend list, excluding self', async () => {
    setUpStore({
      friends: [
        makeFriend({ id: 'me', username: 'me', displayName: 'Me' }),
        makeFriend({ id: 'f1', username: 'alex', displayName: 'Alex' }),
        makeFriend({ id: 'f2', username: 'sam', displayName: 'Sam' }),
      ],
      myUser: { id: 'me', username: 'me' },
    });

    render(<InviteModal />);

    expect(screen.getByText('Invite Friends')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Alex')).toBeInTheDocument();
    });
    expect(screen.getByText('Sam')).toBeInTheDocument();
    // Self is filtered out.
    expect(screen.queryByText('Me')).not.toBeInTheDocument();
  });

  it('grays out friends already in the space using federated identity', async () => {
    // Friend on remote instance orbit.ddns.net, member entry replicated
    // locally with user.homeUserId+homeInstance matching that identity.
    setUpStore({
      friends: [
        makeFriend({
          id: 'local-shadow-id',
          username: 'remoteFriend',
          displayName: 'Remote Friend',
          homeUserId: 'remote-uid-7',
          homeInstance: 'https://orbit.ddns.net',
        }),
      ],
      members: [
        makeMember({
          userId: 'local-replicated-id',
          user: {
            id: 'local-replicated-id',
            username: 'remoteFriend',
            homeUserId: 'remote-uid-7',
            homeInstance: 'https://orbit.ddns.net',
          },
        }),
      ],
    });

    render(<InviteModal />);

    await waitFor(() => {
      expect(screen.getByText('Already in space')).toBeInTheDocument();
    });

    // Clicking the disabled row does not select the friend.
    const button = screen.getByRole('button', { name: /Remote Friend/ });
    expect(button).toBeDisabled();
  });

  it('selecting friends and submitting calls api.dm.spaceInvite once per friend', async () => {
    const user = userEvent.setup();
    mockSpaceInvite.mockResolvedValue({});

    setUpStore({
      friends: [
        makeFriend({ id: 'f1', username: 'alex', displayName: 'Alex' }),
        makeFriend({ id: 'f2', username: 'sam', displayName: 'Sam' }),
      ],
    });

    render(<InviteModal />);

    await waitFor(() => {
      expect(screen.getByText('Alex')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Alex/ }));
    await user.click(screen.getByRole('button', { name: /Sam/ }));

    const submit = screen.getByRole('button', { name: /Send 2 Invites/ });
    await user.click(submit);

    await waitFor(() => {
      expect(mockSpaceInvite).toHaveBeenCalledTimes(2);
    });
    expect(mockSpaceInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'space-1',
        inviteCode: 'test-code',
        target: { userId: 'f1' },
      }),
    );
    expect(mockSpaceInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'space-1',
        inviteCode: 'test-code',
        target: { userId: 'f2' },
      }),
    );
  });

  it('closes the modal after a fully successful send', async () => {
    const user = userEvent.setup();
    mockSpaceInvite.mockResolvedValue({});

    setUpStore({
      friends: [makeFriend({ id: 'f1', username: 'alex', displayName: 'Alex' })],
    });

    render(<InviteModal />);

    await waitFor(() => {
      expect(screen.getByText('Alex')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Alex/ }));
    await user.click(screen.getByRole('button', { name: /Send 1 Invite/ }));

    await waitFor(() => {
      expect(useUIStore.getState().activeModal).toBeNull();
    });
  });

  it('shows the results view with reason text on partial failure', async () => {
    const user = userEvent.setup();
    // f1 succeeds, f2 fails with `not_a_friend`.
    mockSpaceInvite.mockImplementation(({ target }: any) => {
      if (target.userId === 'f1') return Promise.resolve({});
      return Promise.reject(new HttpError(400, 'Not a friend', { error: 'Not a friend', code: 'not_a_friend', statusCode: 400 }, 'not_a_friend'));
    });

    setUpStore({
      friends: [
        makeFriend({ id: 'f1', username: 'alex', displayName: 'Alex' }),
        makeFriend({ id: 'f2', username: 'sam', displayName: 'Sam' }),
      ],
    });

    render(<InviteModal />);

    await waitFor(() => {
      expect(screen.getByText('Alex')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Alex/ }));
    await user.click(screen.getByRole('button', { name: /Sam/ }));
    await user.click(screen.getByRole('button', { name: /Send 2 Invites/ }));

    await waitFor(() => {
      expect(screen.getByText('✓ Sent')).toBeInTheDocument();
    });
    expect(screen.getByText('✗ Not a friend')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry failed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    // Modal must remain open while results are visible.
    expect(useUIStore.getState().activeModal).toBe('invite');
  });

  it('Retry failed re-runs only the failed subset', async () => {
    const user = userEvent.setup();
    mockSpaceInvite.mockImplementation(({ target }: any) => {
      if (target.userId === 'f1') return Promise.resolve({});
      return Promise.reject(new Error('upstream'));
    });

    setUpStore({
      friends: [
        makeFriend({ id: 'f1', username: 'alex', displayName: 'Alex' }),
        makeFriend({ id: 'f2', username: 'sam', displayName: 'Sam' }),
      ],
    });

    render(<InviteModal />);

    await waitFor(() => {
      expect(screen.getByText('Alex')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Alex/ }));
    await user.click(screen.getByRole('button', { name: /Sam/ }));
    await user.click(screen.getByRole('button', { name: /Send 2 Invites/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry failed' })).toBeInTheDocument();
    });
    expect(mockSpaceInvite).toHaveBeenCalledTimes(2);

    // Second pass: Sam succeeds.
    mockSpaceInvite.mockReset();
    mockSpaceInvite.mockResolvedValue({});

    await user.click(screen.getByRole('button', { name: 'Retry failed' }));

    await waitFor(() => {
      expect(mockSpaceInvite).toHaveBeenCalledTimes(1);
    });
    expect(mockSpaceInvite).toHaveBeenCalledWith(
      expect.objectContaining({ target: { userId: 'f2' } }),
    );
  });

  it('share-link footer shows the invite URL and Copy writes to clipboard', async () => {
    setUpStore({
      friends: [],
      generateInvite: vi.fn().mockResolvedValue('abc123'),
    });

    render(<InviteModal />);

    await waitFor(() => {
      expect(screen.getByDisplayValue(/\/join\/abc123/)).toBeInTheDocument();
    });

    // Re-install clipboard spy after render. userEvent.setup() may have replaced
    // navigator.clipboard during initialization; we need a fresh spy that
    // matches what the component will call directly.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    const copyBtn = screen.getByRole('button', { name: 'Copy' });
    copyBtn.click();

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('/join/abc123'),
      );
    });
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('Copy button is disabled while the invite code is loading', () => {
    setUpStore({
      friends: [],
      generateInvite: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    render(<InviteModal />);

    const copyButton = screen.getByRole('button', { name: 'Copy' });
    expect(copyButton).toBeDisabled();
  });

  it('shows an error in the share-link footer when generateInvite fails', async () => {
    setUpStore({
      friends: [],
      generateInvite: vi.fn().mockRejectedValue(new Error('Not authorized')),
    });

    render(<InviteModal />);

    await waitFor(() => {
      expect(screen.getByText('Not authorized')).toBeInTheDocument();
    });
  });

  it('search filters the friend list', async () => {
    const user = userEvent.setup();
    setUpStore({
      friends: [
        makeFriend({ id: 'f1', username: 'alex', displayName: 'Alex' }),
        makeFriend({ id: 'f2', username: 'sam', displayName: 'Sam' }),
      ],
    });

    render(<InviteModal />);

    await waitFor(() => {
      expect(screen.getByText('Alex')).toBeInTheDocument();
    });

    const search = screen.getByPlaceholderText('Search friends...');
    await user.type(search, 'sam');

    await waitFor(() => {
      expect(screen.queryByText('Alex')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Sam')).toBeInTheDocument();
  });

  it('offers the link and the friend list for a space joined by request, and says where the link leads', async () => {
    const user = userEvent.setup();
    const generateInvite = vi.fn().mockResolvedValue('req-code');
    mockSpaceInvite.mockResolvedValue({});
    useUIStore.setState({ activeModal: 'invite', modalData: {} });
    useSpaceStore.setState({
      currentSpaceId: 'space-1',
      spaces: [makeSpace({ visibility: 'request' })] as any,
      members: [],
      generateInvite,
    } as any);
    useSocialStore.setState({
      friends: [makeFriend({ id: 'f1', username: 'alex', displayName: 'Alex' })],
    } as any);
    useAuthStore.setState({ user: { id: 'me', username: 'me' } } as any);

    render(<InviteModal />);

    expect(
      screen.getByText('Send to friends, or share a link. People who open it ask to join, and a manager approves each request.'),
    ).toBeInTheDocument();
    expect(generateInvite).toHaveBeenCalledWith('space-1');
    await waitFor(() => {
      expect(screen.getByDisplayValue(`${window.location.origin}/join/req-code`)).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText('Search friends...')).toBeInTheDocument();

    await user.click(screen.getByText('Alex'));
    await user.click(screen.getByRole('button', { name: /send 1 invite/i }));
    await waitFor(() => expect(mockSpaceInvite).toHaveBeenCalledTimes(1));
    expect(mockSpaceInvite.mock.calls[0][0]).toMatchObject({ spaceId: 'space-1', inviteCode: 'req-code' });
  });

  it('keeps the plain intro for a space that is not joined by request', () => {
    setUpStore();
    render(<InviteModal />);
    expect(screen.getByText('Send to friends, or share a link.')).toBeInTheDocument();
  });

  it('passes federated target shape for remote friends', async () => {
    const user = userEvent.setup();
    mockSpaceInvite.mockResolvedValue({});

    setUpStore({
      friends: [
        makeFriend({
          id: 'local-shadow',
          username: 'remoteAlex',
          displayName: 'Remote Alex',
          homeUserId: 'home-uid-9',
          homeInstance: 'https://orbit.ddns.net',
        }),
      ],
    });

    render(<InviteModal />);

    await waitFor(() => {
      expect(screen.getByText('Remote Alex')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /Remote Alex/ }));
    await user.click(screen.getByRole('button', { name: /Send 1 Invite/ }));

    await waitFor(() => {
      expect(mockSpaceInvite).toHaveBeenCalledWith(
        expect.objectContaining({
          // The home identity as every request names it (`personRequest`):
          // the host, whatever form the row stored it in.
          target: {
            homeUserId: 'home-uid-9',
            homeInstance: 'orbit.ddns.net',
          },
        }),
      );
    });
  });

  it('names a friend native to another connected instance by home identity, not by that instance\'s id', async () => {
    const user = userEvent.setup();
    mockSpaceInvite.mockResolvedValue({});
    setUpStore({
      friends: [makeFriend({ id: 'orbit-native-id', displayName: 'Orbit Native', _instanceOrigin: 'https://orbit.ddns.net' })],
    });

    render(<InviteModal />);
    await user.click(await screen.findByRole('button', { name: /Orbit Native/ }));
    await user.click(screen.getByRole('button', { name: /Send 1 Invite/ }));

    await waitFor(() => expect(mockSpaceInvite).toHaveBeenCalledTimes(1));
    expect(mockSpaceInvite.mock.calls[0][0].target).toEqual({
      homeUserId: 'orbit-native-id',
      homeInstance: 'orbit.ddns.net',
    });
  });

  it('selects two friends from different instances that share a row id separately', async () => {
    const user = userEvent.setup();
    setUpStore({
      friends: [
        makeFriend({ id: 'same-id', displayName: 'Dave', _instanceOrigin: '' }),
        makeFriend({ id: 'same-id', displayName: 'Erin', _instanceOrigin: 'https://orbit.ddns.net' }),
      ],
    });

    render(<InviteModal />);
    await user.click(await screen.findByRole('button', { name: /Dave/ }));

    expect(screen.getByRole('button', { name: /Send 1 Invite/ })).toBeInTheDocument();
  });

  describe('a session signed in to another instance with a federated account (#391)', () => {
    // erin is homed on home.test and signed in to the page's instance; her
    // friendships with home.test's own users exist only there.
    const HOME = 'https://home.test';
    const mockHomeSpaceInvite = vi.fn();
    const erinOnPage = { id: 'erin-page', username: 'erin@home.test', homeInstance: 'home.test', homeUserId: 'erin-true' };

    function connectHome(): void {
      useInstanceStore.setState({
        instances: [{
          origin: HOME,
          label: 'home',
          token: 't',
          username: 'erin',
          status: 'connected',
          user: { id: 'erin-true', username: 'erin' } as ConnectedInstance['user'],
          api: { dm: { spaceInvite: (...args: unknown[]) => mockHomeSpaceInvite(...args) } } as unknown as ConnectedInstance['api'],
        }],
      });
    }

    beforeEach(() => {
      mockHomeSpaceInvite.mockReset();
      mockHomeSpaceInvite.mockResolvedValue({});
      mockSpaceInvite.mockResolvedValue({});
    });

    afterEach(() => {
      useInstanceStore.setState({ instances: [] });
    });

    it('sends the invite to the connected home, naming each friend as the home knows them', async () => {
      const user = userEvent.setup();
      connectHome();
      setUpStore({
        myUser: erinOnPage,
        friends: [
          makeFriend({ id: 'bob-home', displayName: 'Bob', _instanceOrigin: HOME }),
          makeFriend({ id: 'tess-page', displayName: 'Tess', _instanceOrigin: '' }),
        ],
      });

      render(<InviteModal />);
      await user.click(await screen.findByRole('button', { name: /Bob/ }));
      await user.click(screen.getByRole('button', { name: /Tess/ }));
      await user.click(screen.getByRole('button', { name: /Send 2 Invites/ }));

      await waitFor(() => expect(mockHomeSpaceInvite).toHaveBeenCalledTimes(2));
      expect(mockSpaceInvite).not.toHaveBeenCalled();
      const bodies = mockHomeSpaceInvite.mock.calls.map((call) => call[0]);
      // The home's own user by the home's id; the page's user by home identity.
      expect(bodies.map((b) => b.target)).toEqual(expect.arrayContaining([
        { userId: 'bob-home' },
        { homeUserId: 'tess-page', homeInstance: window.location.host },
      ]));
      // The space is on the page's instance, which the home names by origin.
      for (const body of bodies) expect(body.spaceInstanceOrigin).toBe(window.location.origin);
    });

    it('names a space on the home as the home\'s own', async () => {
      const user = userEvent.setup();
      connectHome();
      setUpStore({
        myUser: erinOnPage,
        friends: [makeFriend({ id: 'bob-home', displayName: 'Bob', _instanceOrigin: HOME })],
      });
      useSpaceStore.setState({ spaces: [makeSpace({ _instanceOrigin: HOME })] });

      render(<InviteModal />);
      await user.click(await screen.findByRole('button', { name: /Bob/ }));
      await user.click(screen.getByRole('button', { name: /Send 1 Invite/ }));

      await waitFor(() => expect(mockHomeSpaceInvite).toHaveBeenCalledTimes(1));
      expect(mockHomeSpaceInvite.mock.calls[0][0].spaceInstanceOrigin).toBe('');
    });

    it('falls back to the page\'s instance while the home has no live session', async () => {
      const user = userEvent.setup();
      setUpStore({
        myUser: erinOnPage,
        friends: [makeFriend({ id: 'tess-page', displayName: 'Tess', _instanceOrigin: '' })],
      });

      render(<InviteModal />);
      await user.click(await screen.findByRole('button', { name: /Tess/ }));
      await user.click(screen.getByRole('button', { name: /Send 1 Invite/ }));

      await waitFor(() => expect(mockSpaceInvite).toHaveBeenCalledTimes(1));
      expect(mockHomeSpaceInvite).not.toHaveBeenCalled();
      expect(mockSpaceInvite.mock.calls[0][0]).toEqual(expect.objectContaining({
        target: { userId: 'tess-page' },
        spaceInstanceOrigin: '',
      }));
    });
  });
});
