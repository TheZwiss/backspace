import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@backspace/shared';
import { FriendRequestNotifications } from './FriendRequestNotifications';
import { useAuthStore } from '../stores/authStore';
import { useSocialStore } from '../stores/socialStore';
import { useFriendRequestNotices } from '../utils/friendRequestNotification';
import { openDirectMessage } from '../utils/openDirectMessage';
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
vi.mock('../utils/openDirectMessage', () => ({ openDirectMessage: vi.fn().mockResolvedValue('dm-bob') }));
const user = (id: string) => ({ id, username: id, displayName: id === 'bob' ? 'Bob' : 'Alice', homeUserId: null, homeInstance: null }) as User;
const request = { id: 'r', fromId: 'bob', toId: 'alice', status: 'pending' as const, createdAt: 1, user: user('bob') };
const update = vi.fn().mockResolvedValue(undefined);
function mount() { return render(<MemoryRouter><FriendRequestNotifications /></MemoryRouter>); }
beforeEach(() => {
 vi.clearAllMocks(); useAuthStore.setState({ user: user('alice') });
 useSocialStore.setState({ requests: [{ ...request, _instanceOrigin: '' }], updateFriendRequest: update });
 useFriendRequestNotices.setState({ notices: [{ key: 'alice::r', ownerId: 'alice', request, origin: '' }] });
});
afterEach(() => useFriendRequestNotices.setState({ notices: [] }));
describe('friend request card', () => {
 it('opens the conversation when the main card is clicked', async () => {
  mount(); fireEvent.click(screen.getByRole('button', { name: 'Open conversation with Bob' }));
  await waitFor(() => expect(openDirectMessage).toHaveBeenCalledWith(request.user, ''));
  expect(update).not.toHaveBeenCalled();
 });
 it.each([['Accept', 'accepted'], ['Decline', 'declined']])('uses the %s icon without opening the conversation', async (label, action) => {
  mount(); const button = screen.getByRole('button', { name: label });
  expect(button.textContent).toBe(''); fireEvent.click(button);
  await waitFor(() => expect(update).toHaveBeenCalledWith('r', '', action, request.user));
  expect(openDirectMessage).not.toHaveBeenCalled();
 });
 it('dismisses the card without declining the request', () => {
  mount(); fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(update).not.toHaveBeenCalled(); expect(useFriendRequestNotices.getState().notices).toHaveLength(0);
 });
 it('does not show another account\'s notification', () => {
  useAuthStore.setState({ user: user('another') }); mount();
  expect(screen.queryByText('Bob')).toBeNull();
 });
});
