import type { User } from '@backspace/shared';
import { isOutgoingRequest, type TaggedFriend, type TaggedFriendRequest } from '../stores/socialStore';
import { isMine, userKey, type SelfIdentity } from './identity';

export type FriendshipStatus =
  | { state: 'self' }
  | { state: 'friends'; friend: TaggedFriend }
  | { state: 'outbound_pending'; request: TaggedFriendRequest }
  | { state: 'inbound_pending'; request: TaggedFriendRequest }
  | { state: 'none' };

/**
 * Where the viewer stands with the person `viewedUser` names (as `origin`
 * issued the row). Friends and requests from any instance are matched by
 * person (`userKey`), never by id or username alone.
 */
export function getFriendshipStatus({ viewedUser, origin, self, friends, requests }: { viewedUser: User; origin: string; self: SelfIdentity | null; friends: TaggedFriend[]; requests: TaggedFriendRequest[] }): FriendshipStatus {
  if (!self) return { state: 'none' };
  if (isMine(viewedUser, origin, self)) return { state: 'self' };

  const key = userKey(viewedUser, origin);
  const friend = friends.find(f => userKey(f, f._instanceOrigin) === key);
  if (friend) return { state: 'friends', friend };

  const request = requests.find(r => r.user && userKey(r.user, r._instanceOrigin) === key);
  if (request?.user) {
    return isOutgoingRequest(request)
      ? { state: 'outbound_pending', request }
      : { state: 'inbound_pending', request };
  }

  return { state: 'none' };
}

