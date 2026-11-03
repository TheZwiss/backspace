import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { User } from '@backspace/shared';
import { DmFriendshipBanner } from './DmFriendshipBanner';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
const user = (id: string) => ({ id, username: id, displayName: id, status: 'online', homeUserId: null, homeInstance: null }) as User;
const target = user('bob');
beforeEach(() => {
 useAuthStore.setState({ user: user('alice'), myRowIds: new Map([['', 'alice']]) });
 useSocialStore.setState({ friends: [], requests: [], loadFriends: vi.fn().mockResolvedValue(undefined), loadRequests: vi.fn().mockResolvedValue(undefined) });
});
describe('DM friendship banner', () => {
 it('offers adding a non-friend and sends the request', async () => {
  const sendFriendRequest = vi.fn().mockResolvedValue(undefined); useSocialStore.setState({ sendFriendRequest });
  render(<DmFriendshipBanner user={target} origin="" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add Friend' }));
  await waitFor(() => expect(sendFriendRequest).toHaveBeenCalledWith({ username: 'bob' }));
 });
 it('shows accept and decline only for an incoming request', async () => {
  const updateFriendRequest = vi.fn().mockResolvedValue(undefined);
  useSocialStore.setState({ updateFriendRequest, requests: [{ id: 'r', fromId: 'bob', toId: 'alice', status: 'pending', user: target, _instanceOrigin: '' }] });
  render(<DmFriendshipBanner user={target} origin="" />);
  expect(screen.getByRole('button', { name: 'Accept' })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  await waitFor(() => expect(updateFriendRequest).toHaveBeenCalledWith('r', '', 'declined', target));
 });
 it('offers cancelling an outgoing request instead of accepting it', async () => {
  const cancelFriendRequest = vi.fn().mockResolvedValue(undefined);
  useSocialStore.setState({ cancelFriendRequest, requests: [{ id: 'r', fromId: 'alice', toId: 'bob', status: 'pending', createdAt: 1, user: target, _instanceOrigin: '' }] });
  render(<DmFriendshipBanner user={target} origin="" />);
  expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Request' }));
  await waitFor(() => expect(cancelFriendRequest).toHaveBeenCalledWith('r', '', target));
 });
 it('hides the banner for existing friends', () => {
  useSocialStore.setState({ friends: [{ ...target, _instanceOrigin: '', friendshipId: 'f' }] });
  const { container } = render(<DmFriendshipBanner user={target} origin="" />);
  expect(container.textContent).toBe('');
 });
});
