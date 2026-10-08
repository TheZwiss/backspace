import type { SendFriendRequest } from '@backspace/shared';
import { deliveringHost, homeIdentityOf, parseFederatedUsername, type IdentityFields } from './identity';

/**
 * The body of a friend request for a user the client already holds.
 *
 * A user loaded from somewhere is named by its federated identity, never by
 * its username alone: a replicated row's username is only this instance's
 * label for the person (for a stub minted without a name hint it is
 * `<homeUserId>@<domain>`), and the home server cannot look a person up by it.
 *
 * The identity is `homeIdentityOf(user, origin)`. A native user of the
 * page's own instance (`origin` is `''`) is named by username, which is their
 * handle there.
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
  user: IdentityFields & { username: string },
  origin: string,
): SendFriendRequest {
  const identity = homeIdentityOf(user, origin);
  if (!identity || (origin === '' && !user.homeInstance)) return { username: user.username };
  const { baseName } = parseFederatedUsername(user.username);
  return { username: `${baseName}@${identity.host}`, homeUserId: identity.userId, homeInstance: identity.host };
}

/**
 * `body`, written as the page's own instance reads it, readdressed for the
 * instance `to` (`''` is the page's own) that the request is sent to. A bare
 * username is a handle on the page's instance, so for any other instance it
 * gets the page's host (`bob` becomes `bob@<page host>`), which is what the
 * Add Friend box shows for it. An identity, and a username that already names
 * its host, mean the same on every instance and are sent as they are.
 */
export function addressedTo(body: SendFriendRequest, to: string): SendFriendRequest {
  if (to === '' || body.homeUserId !== undefined || body.homeInstance !== undefined) return body;
  if (body.username === undefined || parseFederatedUsername(body.username).domain !== null) return body;
  return { ...body, username: `${body.username}@${deliveringHost('')}` };
}
