import type { User } from '@backspace/shared';
import type { TFunction } from 'i18next';
import { api } from '../../../api/client';
import { useAuthStore } from '../../../stores/authStore';
import { useSocialStore } from '../../../stores/socialStore';
import { useSpaceStore } from '../../../stores/spaceStore';
import { useUIStore } from '../../../stores/uiStore';
import type { ContextMenuAction } from '../../../stores/contextMenuStore';
import { getFriendshipStatus } from '../../../utils/friendshipStatus';
import { friendRequestTarget } from '../../../utils/friendRequestTarget';
import { describeError } from '../../../i18n/errors';

export async function runMemberAction(action: () => Promise<unknown>): Promise<void> {
  try { await action(); }
  catch (error) { useUIStore.getState().addToast(describeError(error), 'warning'); }
}

export async function sendMemberMessage(user: User, navigate: (path: string) => void): Promise<void> {
  const existing = useSpaceStore.getState().findExistingDmForUser(user);
  const channel = existing?.dm ?? await api.dm.create({
    userId: user.homeInstance ? undefined : user.id,
    homeUserId: user.homeUserId ?? undefined,
    homeInstance: user.homeInstance ?? undefined,
  });
  if (!existing) useSpaceStore.getState().addDmChannel(channel);
  useUIStore.getState().setShowDms(true);
  navigate('/channels/@me/' + channel.id);
}

export function friendshipMenuItems(user: User, t: TFunction<readonly ['spaces', 'social', 'common']>): ContextMenuAction[] {
  const social = useSocialStore.getState();
  const friendship = getFriendshipStatus({ viewedUser: user, currentUser: useAuthStore.getState().user, ...social });
  const action = (key: string, label: string, run: () => Promise<unknown>): ContextMenuAction => ({
    type: 'action', key, label, onClick: () => { void runMemberAction(run); },
  });
  switch (friendship.state) {
    case 'self': return [];
    case 'friends': return [action('remove-friend', t('social:friend.remove'), () => social.removeFriend(friendship.friend.id))];
    case 'outbound_pending': return [action('cancel-friend', t('social:request.cancel'), () => social.cancelFriendRequest(friendship.request.id))];
    case 'inbound_pending': return [
      action('accept-friend', t('common:actions.accept'), () => social.updateFriendRequest(friendship.request.id, 'accepted')),
      action('decline-friend', t('common:actions.decline'), () => social.updateFriendRequest(friendship.request.id, 'declined')),
    ];
    case 'none': {
      // The home identity is authoritative; a replica's username may only be a label.
      return [action('add-friend', t('social:profile.addFriend'), () => social.sendFriendRequest(friendRequestTarget(user, '')))];
    }
  }
}
