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

  // dm
  peer_reset_pending: 'Federation with this instance is being reset; try again shortly',
  dm_target_required: 'userId or (homeUserId + homeInstance) is required',
  cannot_dm_self: 'Cannot create DM with yourself',
  group_dm_too_few_members: 'users must contain at least {{min}} entries',
  group_dm_too_many_members: 'Group DMs are limited to {{max}} members',
  users_not_found: 'One or more users not found',
  duplicate_users: 'Duplicate users after identity resolution',
  group_dm_includes_self: 'Do not include yourself; you are added automatically',
  not_a_friend: 'You can only add friends to group DMs',
  dm_not_found: 'DM channel not found',
  dm_not_group: 'This is a 1-on-1 DM; that action needs a group DM',
  not_dm_member: 'You are not a member of this DM channel',
  dm_owner_only: 'Only the group owner can do that',
  group_dm_name_length: 'Group DM name must be between {{min}} and {{max}} characters',
  icon_url_invalid: 'Invalid icon URL',
  attachment_not_found: 'Attachment not found',
  attachment_not_owned: 'You do not own this attachment',
  icon_not_image: 'Icon must be an image',
  icon_too_large: 'Icon must be smaller than {{max}} MB',
  already_member: 'Already a member',
  owner_cannot_kick_self: 'Owners cannot kick themselves; use leave instead',
  target_not_dm_member: 'Target user is not a member of this DM channel',
  new_owner_required: 'newOwnerId or (homeUserId + homeInstance) is required',
  already_owner: 'Cannot transfer to current owner',
  invalid_body: 'Invalid request body',
  invalid_target: 'Invalid target',
  cannot_invite_self: 'Cannot invite yourself',
  space_requires_approval: 'This space requires approval to join',
  message_lookup_failed: 'Failed to load the message after saving it',
  content_required: 'Message must have content or attachments',
  content_too_long: 'Message content must be {{max}} characters or less',
  reply_target_invalid: 'Invalid reply target',
  attachment_invalid: 'Invalid or already-used attachment',
  message_create_failed: 'Failed to create message',
  message_update_failed: 'Failed to update message',
  message_not_found: 'Message not found',
  not_message_author: 'You can only edit or delete your own messages',
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
