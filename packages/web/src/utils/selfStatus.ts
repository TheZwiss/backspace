import { isChosenUserStatus, ownsChosenStatus, type ChosenUserStatus, type User } from '@backspace/shared';
import { homeHostOf, userKey } from './identity';

/**
 * Where the signed-in user's chosen status lives and how the client reads it.
 * The rule is stated in activity-presence.md ("The client's copy of the user's
 * own status"); everything here is pure, and every caller (the WebSocket
 * handler, the alert gate, the settings panel, `authStore.updateProfile`)
 * derives its answer from `statusAuthority`.
 */

type SessionUser = Pick<User, 'id' | 'status' | 'homeInstance' | 'homeUserId' | 'federationHomeOrphaned'>;

/**
 * - `session`: the page's own account owns its choice (native or detached,
 *   `ownsChosenStatus`); the page's instance is where it is stored.
 * - `trueHome`: the page's account is a replicated row (for example
 *   `erin@nova` signed in directly on orbit); the choice is stored on the true
 *   home, reached through that instance's secondary connection, where the
 *   user's own row has id `userId`.
 */
export type StatusAuthority =
  | { kind: 'session'; userId: string }
  | { kind: 'trueHome'; host: string; userId: string };

export function statusAuthority(user: SessionUser | null | undefined): StatusAuthority | null {
  if (!user) return null;
  if (ownsChosenStatus(user) || !user.homeInstance || !user.homeUserId) {
    return { kind: 'session', userId: user.id };
  }
  return { kind: 'trueHome', host: homeHostOf(user.homeInstance), userId: user.homeUserId };
}

/**
 * The user's chosen status, or null while it is not known. For a `session`
 * authority that is the page account's own status; for `trueHome` it is what
 * the true home last reported (`authStore.trueHomeStatus`), never the page
 * instance's replicated view.
 */
export function myChosenStatus(
  user: SessionUser | null | undefined,
  trueHomeStatus: ChosenUserStatus | null,
): ChosenUserStatus | null {
  const authority = statusAuthority(user);
  if (!authority || !user) return null;
  if (authority.kind === 'trueHome') return trueHomeStatus;
  return isChosenUserStatus(user.status) ? user.status : null;
}

export interface SocketOrigin {
  origin: string;
  isHome: boolean;
}

/** Whether `userId`, as reported over `socket`, is the account that owns the user's choice. */
export function speaksForMyStatus(
  authority: StatusAuthority | null,
  socket: SocketOrigin,
  userId: string,
): boolean {
  if (!authority || userId !== authority.userId) return false;
  if (authority.kind === 'session') return socket.isHome;
  return !socket.isHome && homeHostOf(socket.origin) === authority.host;
}

export interface OwnStatusReport {
  owner: StatusAuthority['kind'];
  status: ChosenUserStatus;
}

/**
 * A status carried by `ready.user`, `user_updated` or `presence_update` that is
 * the owner's own report of the user's choice, and which copy it updates; null
 * for everything else (other users, other instances' views of the user, and
 * 'offline', which describes a connection, never a choice).
 */
export function ownStatusReport(
  user: SessionUser | null | undefined,
  socket: SocketOrigin,
  report: { userId: string; status: unknown },
): OwnStatusReport | null {
  const authority = statusAuthority(user);
  if (!authority || !isChosenUserStatus(report.status)) return null;
  if (!speaksForMyStatus(authority, socket, report.userId)) return null;
  return { owner: authority.kind, status: report.status };
}

type RemoteAccount = Pick<User, 'id' | 'homeInstance' | 'homeUserId'>;

/**
 * Whether a remote instance's account is this user's federated identity there:
 * a replicated row naming the same person as the page's session row
 * (`userKey`). The check `ensureRemoteCredential` applies. A native account
 * someone signed in to on that remote is not, even where its id happens to
 * match.
 */
export function isMyFederatedIdentity(user: SessionUser, remote: RemoteAccount): boolean {
  if (!remote.homeInstance) return false;
  return userKey(remote, '') === userKey(user, '');
}

/**
 * What to send a remote instance on its `ready`, or null. Only an account that
 * owns its choice speaks for it, and only to its own federated identity there,
 * whose view falls back to 'online' after that instance saw this client leave.
 */
export function statusToAssertOnRemote(
  user: SessionUser | null | undefined,
  remote: RemoteAccount & Pick<User, 'status'>,
): ChosenUserStatus | null {
  if (!user || statusAuthority(user)?.kind !== 'session') return null;
  if (!isMyFederatedIdentity(user, remote)) return null;
  const mine = myChosenStatus(user, null);
  if (!mine || mine === remote.status) return null;
  return mine;
}
