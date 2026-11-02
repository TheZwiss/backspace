import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyFriendRequest, useFriendRequestNotices } from './friendRequestNotification';
import { useFriendNotificationPreferences } from '../stores/friendNotificationPreferences';
import { useAuthStore } from '../stores/authStore';
const mocks = vi.hoisted(() => ({ allowed: vi.fn(() => true), sound: vi.fn().mockResolvedValue(null), os: vi.fn() }));
vi.mock('./alerts', () => ({ alertsAllowed: mocks.allowed, playAlertSound: mocks.sound, showAlertNotification: mocks.os }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
const request = { id: 'r', fromId: 'bob', toId: 'alice', createdAt: 1, status: 'pending' as const };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.allowed.mockReturnValue(true); vi.spyOn(document, 'hasFocus').mockReturnValue(true); useAuthStore.setState({ user: { id: 'alice' } as import('@backspace/shared').User }); useFriendNotificationPreferences.setState({ enabled: true, sound: true, desktop: true }); useFriendRequestNotices.setState({ notices: [] }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('incoming friendship notification', () => {
 it('deduplicates a repeated realtime event and expires the card', async () => {
  await notifyFriendRequest(request, ''); await notifyFriendRequest(request, '');
  expect(useFriendRequestNotices.getState().notices).toHaveLength(1); expect(mocks.sound).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(12_000); expect(useFriendRequestNotices.getState().notices).toHaveLength(0);
 });
 it('respects disabled notifications and Do Not Disturb', async () => {
  useFriendNotificationPreferences.setState({ enabled: false }); await notifyFriendRequest(request, '');
  useFriendNotificationPreferences.setState({ enabled: true }); mocks.allowed.mockReturnValue(false); await notifyFriendRequest(request, '');
  expect(mocks.sound).not.toHaveBeenCalled(); expect(useFriendRequestNotices.getState().notices).toHaveLength(0);
 });
 it('keeps the visual notice when its sound is muted', async () => {
  useFriendNotificationPreferences.setState({ sound: false }); await notifyFriendRequest(request, '');
  expect(mocks.sound).not.toHaveBeenCalled(); expect(useFriendRequestNotices.getState().notices).toHaveLength(1);
 });
});
