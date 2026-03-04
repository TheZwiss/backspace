import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FriendsPage } from './FriendsPage';
import { useSocialStore } from '../../stores/socialStore';
import { useServerStore } from '../../stores/serverStore';
import type { Friend, FriendRequest } from '@backspace/shared';

// Mock the api module
vi.mock('../../api/client', () => ({
  api: {
    dm: {
      create: vi.fn(),
    },
    social: {
      friends: vi.fn().mockResolvedValue([]),
      requests: vi.fn().mockResolvedValue([]),
      sendRequest: vi.fn().mockResolvedValue({ success: true }),
      updateRequest: vi.fn().mockResolvedValue({ success: true }),
      cancelRequest: vi.fn().mockResolvedValue({ success: true }),
      removeFriend: vi.fn().mockResolvedValue({ success: true }),
      search: vi.fn().mockResolvedValue([]),
    },
  },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const makeFriend = (overrides: Partial<Friend> = {}): Friend => ({
  id: 'friend-1',
  username: 'testfriend',
  displayName: 'Test Friend',
  avatar: null,
  status: 'online',
  customStatus: null,
  createdAt: Date.now(),
  addedAt: Date.now(),
  ...overrides,
});

const makeRequest = (overrides: Partial<FriendRequest> = {}): FriendRequest => ({
  id: 'req-1',
  fromId: 'other-user',
  toId: 'current-user',
  status: 'pending',
  createdAt: Date.now(),
  user: {
    id: 'other-user',
    username: 'otheruser',
    displayName: 'Other User',
    avatar: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: Date.now(),
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  },
  ...overrides,
});

function renderFriendsPage() {
  return render(
    <MemoryRouter>
      <FriendsPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockNavigate.mockClear();
  // Reset the social store with no-op loaders (we set state directly)
  useSocialStore.setState({
    friends: [],
    requests: [],
    isLoading: false,
    error: null,
    loadFriends: vi.fn(),
    loadRequests: vi.fn(),
  });
  useServerStore.setState({
    dmChannels: [],
  });
});

describe('FriendsPage', () => {
  describe('Add Friend tab', () => {
    it('renders the Add Friend form when tab is clicked', async () => {
      const user = userEvent.setup();
      renderFriendsPage();

      const addFriendTab = screen.getByText('Add Friend');
      await user.click(addFriendTab);

      expect(screen.getByPlaceholderText('You can add a friend with their username')).toBeInTheDocument();
      expect(screen.getByText('Send Friend Request')).toBeInTheDocument();
    });

    it('calls sendFriendRequest with the username when form is submitted', async () => {
      const user = userEvent.setup();
      const mockSendFriendRequest = vi.fn().mockResolvedValue(undefined);
      useSocialStore.setState({
        sendFriendRequest: mockSendFriendRequest,
      });

      renderFriendsPage();

      // Switch to Add Friend tab
      await user.click(screen.getByText('Add Friend'));

      // Type username
      const input = screen.getByPlaceholderText('You can add a friend with their username');
      await user.type(input, 'newbuddy');

      // Click send
      await user.click(screen.getByText('Send Friend Request'));

      await waitFor(() => {
        expect(mockSendFriendRequest).toHaveBeenCalledWith('newbuddy');
      });

      // Should show success message
      await waitFor(() => {
        expect(screen.getByText(/Success! Your friend request to newbuddy has been sent/)).toBeInTheDocument();
      });
    });

    it('shows error when sendFriendRequest fails', async () => {
      const user = userEvent.setup();
      const mockSendFriendRequest = vi.fn().mockRejectedValue(new Error('User not found'));
      useSocialStore.setState({
        sendFriendRequest: mockSendFriendRequest,
      });

      renderFriendsPage();
      await user.click(screen.getByText('Add Friend'));

      const input = screen.getByPlaceholderText('You can add a friend with their username');
      await user.type(input, 'ghost');
      await user.click(screen.getByText('Send Friend Request'));

      await waitFor(() => {
        expect(screen.getByText('User not found')).toBeInTheDocument();
      });
    });
  });

  describe('DM button on friend item', () => {
    it('calls api.dm.create and navigates when clicking the Message button', async () => {
      const user = userEvent.setup();
      const friend = makeFriend({ id: 'friend-42', username: 'dmpal', displayName: 'DM Pal' });
      const mockAddDmChannel = vi.fn();

      useSocialStore.setState({
        friends: [friend],
        requests: [],
      });
      useServerStore.setState({
        addDmChannel: mockAddDmChannel,
      });

      // Mock the dm.create API
      const { api } = await import('../../api/client');
      (api.dm.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'dm-channel-99',
        createdAt: Date.now(),
        members: [],
      });

      renderFriendsPage();

      // Switch to "All" tab to see the friend
      await user.click(screen.getByText('All'));

      // Find the Message button by title
      const dmButton = screen.getByTitle('Message');
      await user.click(dmButton);

      await waitFor(() => {
        expect(api.dm.create).toHaveBeenCalledWith({ userId: 'friend-42' });
      });

      await waitFor(() => {
        expect(mockAddDmChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'dm-channel-99' }));
      });

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/channels/@me/dm-channel-99');
      });
    });
  });

  describe('Cancel outgoing friend request', () => {
    it('calls cancelFriendRequest when clicking cancel on an outgoing request', async () => {
      const user = userEvent.setup();
      const mockCancel = vi.fn().mockResolvedValue(undefined);

      // Outgoing request: user.id === toId means current user sent it (fromId is current user, user is the recipient)
      const outgoingRequest = makeRequest({
        id: 'req-out-1',
        fromId: 'current-user',
        toId: 'other-user',
        user: {
          id: 'other-user',
          username: 'recipient',
          displayName: 'Recipient',
          avatar: null,
          status: 'online',
          customStatus: null,
          isAdmin: false,
          createdAt: Date.now(),
          homeInstance: null,
          homeUserId: null,
          replicatedInstances: [],
        },
      });

      useSocialStore.setState({
        friends: [],
        requests: [outgoingRequest],
        cancelFriendRequest: mockCancel,
      });

      renderFriendsPage();

      // Switch to Pending tab
      await user.click(screen.getByText('Pending'));

      // Should see the outgoing request
      expect(screen.getByText('Outgoing Friend Request')).toBeInTheDocument();

      // Click the cancel button (the X icon button with title "Cancel Request")
      const cancelButton = screen.getByTitle('Cancel Request');
      await user.click(cancelButton);

      await waitFor(() => {
        expect(mockCancel).toHaveBeenCalledWith('req-out-1');
      });
    });
  });

  describe('Accept/Decline incoming friend request', () => {
    it('calls updateFriendRequest with "accepted" when clicking accept', async () => {
      const user = userEvent.setup();
      const mockUpdate = vi.fn().mockResolvedValue(undefined);

      const incomingRequest = makeRequest({
        id: 'req-in-1',
        fromId: 'sender-id',
        toId: 'current-user',
        user: {
          id: 'sender-id',
          username: 'sender',
          displayName: 'Sender',
          avatar: null,
          status: 'online',
          customStatus: null,
          isAdmin: false,
          createdAt: Date.now(),
          homeInstance: null,
          homeUserId: null,
          replicatedInstances: [],
        },
      });

      useSocialStore.setState({
        friends: [],
        requests: [incomingRequest],
        updateFriendRequest: mockUpdate,
      });

      renderFriendsPage();
      await user.click(screen.getByText('Pending'));

      expect(screen.getByText('Incoming Friend Request')).toBeInTheDocument();

      // Click accept button (title "Accept")
      const acceptButton = screen.getByTitle('Accept');
      await user.click(acceptButton);

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith('req-in-1', 'accepted');
      });
    });

    it('calls updateFriendRequest with "declined" when clicking decline', async () => {
      const user = userEvent.setup();
      const mockUpdate = vi.fn().mockResolvedValue(undefined);

      const incomingRequest = makeRequest({
        id: 'req-in-2',
        fromId: 'sender-id',
        toId: 'current-user',
        user: {
          id: 'sender-id',
          username: 'sender2',
          displayName: 'Sender 2',
          avatar: null,
          status: 'online',
          customStatus: null,
          isAdmin: false,
          createdAt: Date.now(),
          homeInstance: null,
          homeUserId: null,
          replicatedInstances: [],
        },
      });

      useSocialStore.setState({
        friends: [],
        requests: [incomingRequest],
        updateFriendRequest: mockUpdate,
      });

      renderFriendsPage();
      await user.click(screen.getByText('Pending'));

      const declineButton = screen.getByTitle('Decline');
      await user.click(declineButton);

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith('req-in-2', 'declined');
      });
    });
  });
});
