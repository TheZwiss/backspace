/**
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
    case 'username_required': return 'Enter a username.';
    case 'cannot_friend_self': return "You can't friend yourself.";
    case 'peer_rejected':
      return `Instance has rejected federation. Contact your admin.`;
    case 'user_not_found':
      return `No user "${handle}" on the remote instance.`;
    case 'already_friends': return "You're already friends with this user.";
    case 'peer_pending_approval':
      return "The remote instance's admin needs to approve federation. Try again later.";
    case 'peer_pending_local_admin':
      return "Your admin needs to approve federation with this instance. You'll see your request in Connections settings.";
    case 'peer_pending':
      return 'Connecting to the remote instance — try again in a moment.';
    case 'incoming_request_exists':
      return `${handle} has already sent you a request — open the Pending tab.`;
    case 'lookup_rate_limited': return 'Too many lookups; try again in a minute.';
    case 'peer_unreachable': return 'The remote instance is currently unreachable.';
    case 'invalid_target_domain': return 'Invalid target domain.';
    case 'not_authoritative_for_sender':
      // Should not happen in normal client usage — internal protocol violation.
      return 'Could not send friend request (authority error).';
    default: return fallback ?? 'Could not send friend request.';
  }
}
