import type { User } from '@backspace/shared';
import type { TaggedFriend, TaggedFriendRequest } from '../stores/socialStore';
import { isSelf, canonicalUserMatch } from './identity';

export type FriendshipStatus =
  | { state: 'self' }
  | { state: 'friends'; friend: TaggedFriend }
  | { state: 'outbound_pending'; request: TaggedFriendRequest }
  | { state: 'inbound_pending'; request: TaggedFriendRequest }
  | { state: 'none' };

export function getFriendshipStatus({ viewedUser, currentUser, friends, requests }: {
  viewedUser: User;
  currentUser: User | null;
  friends: TaggedFriend[];
  requests: TaggedFriendRequest[];
}): FriendshipStatus {
  if (!currentUser) return { state: 'none' };
  if (isSelf(viewedUser, currentUser)) return { state: 'self' };

  const friend = friends.find(f => canonicalUserMatch(f, viewedUser));
  if (friend) return { state: 'friends', friend };

  const request = requests.find(r =>
    r.user && canonicalUserMatch(r.user, viewedUser)
  );
  if (request?.user) {
    // request.user is the OTHER party. If their ID === toId, then I am fromId (outbound)
    const isOutbound = request.user.id === request.toId;
    return isOutbound
      ? { state: 'outbound_pending', request }
      : { state: 'inbound_pending', request };
  }

  return { state: 'none' };
}
