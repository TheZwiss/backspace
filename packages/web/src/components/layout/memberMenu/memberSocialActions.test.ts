import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@backspace/shared';
import i18n from '../../../i18n';
import { openDirectMessage } from '../../../utils/openDirectMessage';
import { useAuthStore } from '../../../stores/authStore';
import { useSocialStore } from '../../../stores/socialStore';
import { useUIStore } from '../../../stores/uiStore';
import { friendshipMenuItems, sendMemberMessage } from './memberSocialActions';

vi.mock('../../../utils/openDirectMessage', () => ({ openDirectMessage: vi.fn() }));
vi.mock('../../../audio/AudioManager', () => ({ AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
const user = (id: string): User => ({
  id, username: id, displayName: id, avatar: null, banner: null, accentColor: null,
  avatarColor: null, bio: null, status: 'online', customStatus: null, isAdmin: false, replicatedInstances: [], createdAt: 1, homeInstance: null, homeUserId: null
});
const t = i18n.getFixedT('en', ['spaces', 'social', 'common'] as const);
const target = user('target');
const items = () => friendshipMenuItems(target, '', t);
const request = { id: 'request', fromId: 'viewer', toId: 'target', status: 'pending' as const, createdAt: 1, user: target, _instanceOrigin: '' };

beforeEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user: user('viewer') });
  useSocialStore.setState({ friends: [], requests: [] });
  vi.mocked(openDirectMessage).mockReset();
});

describe('member social actions', () => {
  it('sends an add-friend request using the account name, not the space nickname', async () => {
    const send = vi.spyOn(useSocialStore.getState(), 'sendFriendRequest').mockResolvedValue(undefined);
    const menu = items();
    expect(menu.map(item => item.key)).toEqual(['add-friend']);
    menu[0]!.onClick();
    expect(send).toHaveBeenCalledWith({ username: 'target' });
  });

  it('uses the canonical home handle for a remote member', () => {
    const send = vi.spyOn(useSocialStore.getState(), 'sendFriendRequest').mockResolvedValue(undefined);
    friendshipMenuItems({ ...target, username: 'target@replica.test', homeInstance: 'home.test', homeUserId: 'home-id' }, '', t)[0]!.onClick();
    expect(send).toHaveBeenCalledWith({ username: 'target@home.test', homeUserId: 'home-id', homeInstance: 'home.test' });
  });

  it('offers only removal for existing friends', () => {
    const remove = vi.spyOn(useSocialStore.getState(), 'removeFriend').mockResolvedValue(undefined);
    useSocialStore.setState({ friends: [{ ...target, addedAt: 1, _instanceOrigin: '' }] });
    expect(items().map(item => item.key)).toEqual(['remove-friend']);
    items()[0]!.onClick(); expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'target' }), '');
  });

  it('cancels outbound requests', () => {
    const cancel = vi.spyOn(useSocialStore.getState(), 'cancelFriendRequest').mockResolvedValue(undefined);
    useSocialStore.setState({ requests: [request] });
    expect(items().map(item => item.key)).toEqual(['cancel-friend']);
    items()[0]!.onClick(); expect(cancel).toHaveBeenCalledWith('request', '', target);
  });

  it.each([['accept-friend', 'accepted'], ['decline-friend', 'declined']] as const)('handles inbound %s', (key, status) => {
    const update = vi.spyOn(useSocialStore.getState(), 'updateFriendRequest').mockResolvedValue(undefined);
    useSocialStore.setState({ requests: [{ ...request, fromId: 'target', toId: 'viewer' }] });
    expect(items().map(item => item.key)).toEqual(['accept-friend', 'decline-friend']);
    items().find(item => item.key === key)!.onClick(); expect(update).toHaveBeenCalledWith('request', '', status, target);
  });

  it('does not offer friend operations for oneself', () => {
    expect(friendshipMenuItems(user('viewer'), '', t)).toEqual([]);
  });

  it('opens a DM through the shared origin-aware entry point', async () => {
    vi.mocked(openDirectMessage).mockResolvedValue('dm-existing');
    const navigate = vi.fn();
    await sendMemberMessage(target, '', navigate);
    expect(openDirectMessage).toHaveBeenCalledWith(target, '');
    expect(navigate).toHaveBeenCalledWith('/channels/@me/dm-existing');
    expect(useUIStore.getState().showDms).toBe(true);
  });

  it('preserves a remote member identity and its source origin', async () => {
    const remote = { ...target, id: 'stub-id', homeUserId: 'home-id', homeInstance: 'home.test' };
    vi.mocked(openDirectMessage).mockResolvedValue('dm-remote');
    const navigate = vi.fn();
    await sendMemberMessage(remote, 'https://replica.test', navigate);
    expect(openDirectMessage).toHaveBeenCalledWith(remote, 'https://replica.test');
    expect(navigate).toHaveBeenCalledWith('/channels/@me/dm-remote');
  });

  it('does not navigate after DM creation fails', async () => {
    vi.mocked(openDirectMessage).mockRejectedValue(new Error('DM rejected'));
    const navigate = vi.fn();
    await expect(sendMemberMessage(target, '', navigate)).rejects.toThrow('DM rejected');
    expect(navigate).not.toHaveBeenCalled();
  });
});
