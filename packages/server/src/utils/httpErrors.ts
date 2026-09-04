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

  // misc
  channel_not_found: 'Channel not found',
  message_not_found: 'Message not found',
  not_dm_member: 'You are not a member of this DM channel',
  missing_permission: 'Missing permissions',
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
