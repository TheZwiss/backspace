import { openDirectMessage } from '../../../utils/openDirectMessage';
import { selfIdentityOf } from '../../../utils/identity';
import type { User } from '@backspace/shared';
import type { TFunction } from 'i18next';
import { useAuthStore } from '../../../stores/authStore';
import { useSocialStore } from '../../../stores/socialStore';
import { useUIStore } from '../../../stores/uiStore';
import type { ContextMenuAction } from '../../../stores/contextMenuStore';
import { getFriendshipStatus } from '../../../utils/friendshipStatus';
import { friendRequestTarget } from '../../../utils/friendRequestTarget';
import { describeError } from '../../../i18n/errors';

export async function runMemberAction(action: () => Promise<unknown>): Promise<void> {
  try { await action(); }
  catch (error) { useUIStore.getState().addToast(describeError(error), 'warning'); }
}

export async function sendMemberMessage(user: User, origin: string, navigate: (path: string) => void): Promise<void> {
  const channelId = await openDirectMessage(user, origin);
  useUIStore.getState().setShowDms(true);
  navigate('/channels/@me/' + channelId);
}

export function friendshipMenuItems(user: User, origin: string, t: TFunction<readonly ['spaces', 'social', 'common']>): ContextMenuAction[] {
  const social = useSocialStore.getState();
  const auth = useAuthStore.getState();
  const friendship = getFriendshipStatus({ viewedUser: user, origin, self: selfIdentityOf(auth.user, auth.myRowIds), ...social });
  const action = (key: string, label: string, run: () => Promise<unknown>): ContextMenuAction => ({
    type: 'action', key, label, onClick: () => { void runMemberAction(run); },
  });
  switch (friendship.state) {
    case 'self': return [];
    case 'friends': return [action('remove-friend', t('social:friend.remove'), () => social.removeFriend(friendship.friend, friendship.friend._instanceOrigin))];
    case 'outbound_pending': return [action('cancel-friend', t('social:request.cancel'), () => social.cancelFriendRequest(friendship.request.id, friendship.request._instanceOrigin, friendship.request.user ?? undefined))];
    case 'inbound_pending': return [
      action('accept-friend', t('common:actions.accept'), () => social.updateFriendRequest(friendship.request.id, friendship.request._instanceOrigin, 'accepted', friendship.request.user ?? undefined)),
      action('decline-friend', t('common:actions.decline'), () => social.updateFriendRequest(friendship.request.id, friendship.request._instanceOrigin, 'declined', friendship.request.user ?? undefined)),
    ];
    case 'none': {
      // The home identity is authoritative; a replica's username may only be a label.
      return [action('add-friend', t('social:profile.addFriend'), () => social.sendFriendRequest(friendRequestTarget(user, origin)))];
    }
  }
}
