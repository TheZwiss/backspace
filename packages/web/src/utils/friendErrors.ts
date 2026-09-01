
import { translate } from '../i18n';/**
 * Map a server error code (from POST /api/social/requests) to a human-readable
 * toast message. The server emits these codes; the client renders them.
 *
 * Used by FriendsPage and UserProfileModal when the server returns an error
 * from the friend-add flow.
 */
export function mapServerErrorToMessage(
  code: string | undefined,
  fallback: string | undefined,
  handle: string,
): string {
  switch (code) {
    case 'username_required': return translate('runtime.selected.friendErrors.enterAUsername');
    case 'cannot_friend_self': return translate('runtime.selected.friendErrors.youCanTFriendYourself');
    case 'peer_rejected':
      return `Instance has rejected federation. Contact your admin.`;
    case 'user_not_found':
      return translate('runtime.templates.friendErrors.noUserOnTheRemoteInstance', { p0: handle });
    case 'already_friends': return "You're already friends with this user.";
    case 'peer_pending_approval':
      return translate('runtime.selected.friendErrors.theRemoteInstanceSAdminNeedsToApprove');
    case 'peer_pending_local_admin':
      return translate('runtime.selected.friendErrors.yourAdminNeedsToApproveFederationWithThis');
    case 'peer_pending':
      return translate('runtime.selected.friendErrors.connectingToTheRemoteInstanceTryAgainIn');
    case 'incoming_request_exists':
      return translate('runtime.templates.friendErrors.hasAlreadySentYouARequestOpenThe', { p0: handle });
    case 'lookup_rate_limited': return translate('runtime.selected.friendErrors.tooManyLookupsTryAgainInAMinute');
    case 'peer_unreachable': return translate('runtime.selected.friendErrors.theRemoteInstanceIsCurrentlyUnreachable');
    case 'invalid_target_domain': return translate('runtime.selected.friendErrors.invalidTargetDomain');
    case 'not_authoritative_for_sender':
      // Should not happen in normal client usage — internal protocol violation.
      return translate('runtime.selected.friendErrors.couldNotSendFriendRequestAuthorityError');
    default: return fallback ?? translate('runtime.selected.friendErrors.couldNotSendFriendRequest');
  }
}
