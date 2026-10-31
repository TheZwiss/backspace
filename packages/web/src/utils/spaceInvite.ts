import type { TFunction } from 'i18next';
import type { SpaceInviteRequest } from '@backspace/shared';
import { HttpError } from '../api/client';
import { getFriendsHomeOrigin } from '../stores/instanceStore';
import { getApiForOrigin } from './crossStoreResolvers';
import { personRequest } from './identity';
import type { TaggedFriend } from '../stores/socialStore';

/**
 * Sending a space invite to a friend over DM. Shared by the two entry points:
 * InviteModal (pick friends for the open space) and InviteFriendModal (pick a
 * space for one friend). The wire shape and the home-origin routing are the
 * same from either direction, so they live here rather than in two copies.
 */

export type SpaceInviteSendStatus =
  | { kind: 'pending' }
  | { kind: 'success' }
  | { kind: 'failure'; reason: string };

type InviteT = TFunction<['spaces', 'common']>;

/** The space the invite is for, as the sender's home reads it. */
export interface SpaceInviteSource {
  spaceId: string;
  /** The space's instance origin (`''` for the page's own instance). */
  instanceOrigin: string;
  inviteCode: string;
}

/**
 * How the instance at `to` is told who the invite is for: the friend's id
 * there when they are native to it, else their home identity
 * (`personRequest`). Null for a legacy stub another instance issued, which
 * cannot be named to `to`.
 */
export function inviteTarget(friend: TaggedFriend, to: string): SpaceInviteRequest['target'] | null {
  const request = personRequest(friend, friend._instanceOrigin, to);
  if (request.origin !== to) return null;
  const { userId, homeUserId, homeInstance } = request.target;
  if (homeUserId && homeInstance) return { homeUserId, homeInstance };
  return userId ? { userId } : null;
}

/**
 * The space's instance as the instance at `to` reads it. `''` on the wire
 * means the receiving server's own space, so it is sent only when the space
 * is on `to`; a space on the page's own instance (`spaceOrigin` `''`) is
 * named by the page's origin when the invite goes elsewhere.
 */
export function spaceOriginFor(spaceOrigin: string, to: string): string {
  if (spaceOrigin === to) return '';
  return spaceOrigin || window.location.origin;
}

/**
 * Row-sized copy for each way a space invite can fail. Keyed on the server's
 * error code; the two message checks below cover a failed fetch and the
 * client-side "upstream" marker, which never carry a code.
 */
export function spaceInviteFailureReason(error: unknown, t: InviteT): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case 'invite_invalid': return t('spaces:invite.failure.inviteInvalid');
      case 'not_a_friend': return t('spaces:invite.failure.notAFriend');
      case 'user_not_found': return t('spaces:invite.failure.userNotFound');
      case 'already_member': return t('spaces:invite.failure.alreadyMember');
      case 'cannot_invite_self': return t('spaces:invite.failure.cannotInviteSelf');
      case 'invalid_body': return t('spaces:invite.failure.invalidBody');
      case 'invalid_target': return t('spaces:invite.failure.invalidTarget');
      default:
        break;
    }
  }
  if (error instanceof Error) {
    if (error.message === 'upstream') {
      return t('spaces:invite.failure.upstream');
    }
    if (/network|fetch|failed to fetch/i.test(error.message)) {
      return t('spaces:invite.failure.unreachable');
    }
  }
  return t('spaces:invite.failure.serverError');
}

/**
 * Send one space invite to `friend`. Invites go to the user's home
 * (`getFriendsHomeOrigin`), whose friend list they are checked against and
 * whose copy of each 1-on-1 the user reads; on a session signed in to another
 * instance that is a secondary connection, not the page's own instance.
 */
export async function sendSpaceInvite(
  friend: TaggedFriend,
  space: SpaceInviteSource,
  t: InviteT,
): Promise<SpaceInviteSendStatus> {
  const home = getFriendsHomeOrigin();
  const target = inviteTarget(friend, home);
  if (!target) {
    return { kind: 'failure', reason: t('spaces:invite.failure.invalidTarget') };
  }
  try {
    await getApiForOrigin(home).dm.spaceInvite({
      target,
      spaceId: space.spaceId,
      spaceInstanceOrigin: spaceOriginFor(space.instanceOrigin, home),
      inviteCode: space.inviteCode,
    });
    return { kind: 'success' };
  } catch (err) {
    return { kind: 'failure', reason: spaceInviteFailureReason(err, t) };
  }
}
