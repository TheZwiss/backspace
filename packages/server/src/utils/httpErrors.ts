import type { FastifyReply } from 'fastify';
import type { ErrorCode, ErrorDetails } from '@backspace/shared/src/errors';

/**
 * English text for every shared error code.
 *
 * This is the `error` field of the response: what logs show, and what a
 * client that predates the code displays. Clients that know the code show
 * their own localized text instead, so this copy never needs to be pretty
 * in more than one language. `{{min}}` and `{{max}}` are filled from the
 * details a route passes.
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  not_found: 'Not found',
  forbidden: 'Forbidden',
  unauthorized: 'Unauthorized',
  validation_failed: 'Validation failed',
  rate_limited: 'Too many requests',

  username_required: 'Username is required',
  password_required: 'Password is required',
  username_invalid: 'Username must be {{min}}-{{max}} lowercase alphanumeric/underscore characters',
  username_too_long: 'Usernames can be at most {{max}} characters',
  username_taken: 'Username is already taken',
  password_too_short: 'Password must be at least {{min}} characters',
  password_too_long: 'Password can be at most {{max}} characters',
  invalid_credentials: 'Invalid username or password',
  registration_closed: 'Registration is closed',
  invite_required: 'An invite is required to register',
  invite_invalid: 'Invite is invalid or expired',
  current_password_incorrect: 'Current password is incorrect',
  password_unchanged: 'New password must differ from the current password',
  display_name_too_long: 'Display name can be at most {{max}} characters',
  bio_too_long: 'Bio can be at most {{max}} characters',
  custom_status_too_long: 'Custom status can be at most {{max}} characters',
  profile_managed_by_home: 'Profile fields are managed by your home instance',
  account_deletion_blocked_owned_spaces: 'Transfer or delete the spaces you own before deleting your account',
  account_deletion_password_incorrect: 'Password is incorrect',

  cannot_friend_self: 'You cannot add yourself as a friend',
  user_not_found: 'User not found',
  already_friends: 'You are already friends with this user',
  incoming_request_exists: 'This user has already sent you a friend request',
  invalid_target_domain: 'Invalid target domain',
  lookup_rate_limited: 'Too many lookups; try again in a minute',
  not_authoritative_for_sender: 'This instance is not authoritative for the sender',

  peer_rejected: 'The remote instance has rejected federation',
  peer_pending: 'Federation with the remote instance is still being established',
  peer_pending_approval: 'The remote instance has not approved federation yet',
  peer_pending_local_admin: 'Your admin has not approved federation with this instance yet',
  peer_unreachable: 'The remote instance is unreachable',
  PEER_EXISTS_RESET_REQUIRED: 'A peer record for this instance already exists; reset it first',

  recipient_deleted: "This user's account was deleted",

  // spaces
  space_name_required: 'Space name is required',
  space_name_length: 'Space name must be between {{min}} and {{max}} characters',
  space_create_failed: 'Failed to create space',
  space_not_found: 'Space not found',
  not_space_member: 'You are not a member of this space',
  missing_permission: 'Missing {{permission}} permission',
  avatar_color_invalid: 'Invalid avatar color',
  space_visibility_invalid: 'Visibility must be "public", "request", or "private"',
  no_fields_to_update: 'No fields to update',
  space_update_failed: 'Failed to update space',
  space_owner_only: 'Only the space owner can do that',
  space_uses_join_requests: 'Request-only spaces do not use invite links; entry is by join request',
  invite_code_required: 'Invite code is required',
  invite_not_found: 'Invalid invite code',
  user_banned: 'You are banned from this space',
  already_member: 'You are already a member of this space',
  join_request_required: 'This space requires an approved join request',
  cannot_change_own_roles: 'You cannot change your own roles',
  role_ids_invalid: 'roleIds must be an array of role IDs',
  member_not_found: 'Member not found',
  role_not_in_space: 'Role {{roleId}} does not belong to this space',
  everyone_role_not_assignable: '@everyone role is implicit and cannot be assigned',
  member_update_failed: 'Failed to update member',
  space_owner_cannot_leave: 'Space owner cannot leave. Transfer ownership or delete the space.',
  cannot_target_owner: 'The space owner cannot be removed or banned',
  cannot_target_self: 'You cannot do that to yourself',
  permissions_invalid: 'Invalid permissions value',
  role_name_taken: 'A role with this name already exists',
  role_name_required: 'Role name cannot be empty',
  everyone_role_not_deletable: 'Cannot delete the @everyone role',
  new_owner_required: 'newOwnerId is required',
  already_owner: 'You are already the owner',
  new_owner_not_member: 'New owner must be a member of the space',
  ownership_transfer_failed: 'Failed to transfer ownership',
  user_id_required: 'userId is required',
  already_banned: 'User is already banned',
  ban_not_found: 'Ban not found',
  // channels-messages
  channel_not_found: 'Channel not found',
  category_not_found: 'Category not found',
  message_not_found: 'Message not found',
  channel_name_required: 'Channel name is required',
  channel_name_length: 'Channel name must be between {{min}} and {{max}} characters',
  channel_type_invalid: 'Channel type must be "text" or "voice"',
  category_not_in_space: 'Category {{id}} does not belong to this space',
  channel_not_in_space: 'Channel {{id}} does not belong to this space',
  position_invalid: 'Position must be a non-negative number',
  override_target_invalid: 'targetType must be "role" or "member"',
  override_target_required: 'targetId is required',
  override_bits_invalid: 'allow and deny must be valid decimal integer strings',
  cannot_grant_unowned_permissions: 'Cannot grant permissions you do not possess',
  cannot_deny_unowned_permissions: 'Cannot deny permissions you do not possess',
  category_name_required: 'Category name is required',
  category_name_length: 'Category name must be between {{min}} and {{max}} characters',
  layout_arrays_required: 'channels and categories arrays are required',
  message_empty: 'Message must have content or attachments',
  content_required: 'Content is required',
  content_too_long: 'Message content must be {{max}} characters or less',
  reply_target_invalid: 'Invalid reply target',
  attachment_invalid: 'Invalid or already-used attachment',
  attachment_not_owned: 'You do not own this attachment',
  message_edit_not_author: 'You can only edit your own messages',
  message_delete_forbidden: 'You cannot delete this message',
  internal_error: 'Something went wrong on the server',
  // misc
  not_dm_member: 'You are not a member of this DM channel',
  voice_disabled: 'Voice/video is not configured on this server',
  voice_connect_forbidden: 'Missing CONNECT permission',
  file_not_found: 'File not found',
};

function fillPlaceholders(text: string, details: ErrorDetails | undefined): string {
  if (!details) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = details[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Send an error response in the shared contract: `{ error, code, statusCode, details? }`.
 *
 * Use as `return sendError(reply, 400, 'username_required')`. The English
 * text comes from ERROR_MESSAGES so a route never invents wording, and the
 * code is what lets the client say it in the user's language.
 */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  details?: ErrorDetails,
): FastifyReply {
  const body: { error: string; code: ErrorCode; statusCode: number; details?: ErrorDetails } = {
    error: fillPlaceholders(ERROR_MESSAGES[code], details),
    code,
    statusCode,
  };
  if (details) body.details = details;
  return reply.code(statusCode).send(body);
}
