import type { SendFriendRequest } from '@backspace/shared';
import { normalizeOriginToHost, parseFederatedUsername } from './identity';

/**
 * The body of a friend request for a user the client already holds.
 *
 * A user loaded from somewhere is named by its federated identity, never by
 * its username alone: a replicated row's username is only this instance's
 * label for the person (for a stub minted without a name hint it is
 * `<homeUserId>@<domain>`), and the home server cannot look a person up by it.
 *
 * - A replicated row (`homeInstance` set) carries its home identity.
 * - A user native to the remote instance it was loaded from (`origin`) is
 *   that instance's user by its id there.
 * - A native user of the home instance (`origin` is `''`) is named by
 *   username, which is their handle.
 *
 * `username` is always sent too, as `name@host` for a federated target: a
 * home server that predates the identity fields ignores them and reads it.
 * A replicated row without a `homeUserId` has no identity to send, so it
 * keeps the username only.
 *
 * Requests typed by the user (`name` or `name@domain`) do not come here; they
 * send `{ username }` as typed.
 */
export function friendRequestTarget(
  user: { id: string; username: string; homeUserId?: string | null; homeInstance?: string | null },
  origin: string,
): SendFriendRequest {
  const { baseName } = parseFederatedUsername(user.username);

  if (user.homeInstance) {
    const host = normalizeOriginToHost(user.homeInstance);
    if (!user.homeUserId || !host) return { username: user.username };
    return { username: `${baseName}@${host}`, homeUserId: user.homeUserId, homeInstance: host };
  }

  if (origin) {
    const host = normalizeOriginToHost(origin);
    if (host) return { username: `${baseName}@${host}`, homeUserId: user.id, homeInstance: host };
  }

  return { username: user.username };
}
