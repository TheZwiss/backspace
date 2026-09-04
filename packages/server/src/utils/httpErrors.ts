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

  // admin-settings
  field_not_boolean: '{{field}} must be a boolean',
  instance_settings_missing: 'Instance settings not initialized',
  instance_settings_reload_failed: 'Failed to read updated settings',
  instance_name_length: 'Instance name must be {{min}}-{{max}} characters',
  upload_limit_out_of_range: 'maxUploadSizeMb must be a positive integer ({{min}} - {{max}})',
  relay_ttl_out_of_range: 'federationRelayTtlDays must be an integer between {{min}} and {{max}}',
  rotation_interval_out_of_range: 'defaultAutoRotateIntervalDays must be an integer between {{min}} and {{max}}',
  streaming_max_bitrate_out_of_range: 'maxBitrateKbps must be between {{min}} and {{max}}',
  streaming_min_bitrate_out_of_range: 'minBitrateKbps must be between {{min}} and {{max}}',
  streaming_bitrate_step_out_of_range: 'bitrateStepKbps must be between {{min}} and {{max}}',
  streaming_min_bitrate_not_below_max: 'minBitrateKbps must be less than maxBitrateKbps',
  streaming_resolutions_required: 'allowedResolutions must be a non-empty array',
  streaming_resolutions_invalid: 'Invalid resolutions: {{invalid}}. Allowed: {{allowed}}',
  streaming_framerates_required: 'allowedFramerates must be a non-empty array',
  streaming_framerates_invalid: 'Invalid framerates: {{invalid}}. Allowed: {{allowed}}',
  streaming_max_resolution_invalid: 'maxResolution must be one of: {{allowed}}',
  streaming_max_framerate_invalid: 'maxFramerate must be one of: {{allowed}}',
  streaming_bitrate_matrix_invalid: 'bitrateMatrixOverrides must be an object or null',
  streaming_bitrate_matrix_key_invalid: 'Invalid matrix key: "{{key}}". Keys must be {resolution}_{framerate}, e.g. "1080_60"',
  streaming_bitrate_matrix_value_invalid: 'Invalid value for "{{key}}": must be a positive number up to {{max}} kbps',
  storage_stats_failed: 'Failed to compute storage stats: {{reason}}',
  storage_orphans_failed: 'Failed to list orphaned files: {{reason}}',
  storage_cleanup_failed: 'Cleanup failed: {{reason}}',
  media_cleanup_failed: 'Media cleanup failed: {{reason}}',
  upload_session_cleanup_failed: 'Tus cleanup failed: {{reason}}',
  cleanup_age_invalid: '{{field}} must be a positive number',
  deleted_user_role_change: 'Cannot change role of a deleted user',
  deleted_user_password_reset: 'Cannot reset password of a deleted user',
  user_already_deleted: 'User is already deleted',
  federated_user_cannot_be_admin: 'Federated users cannot be promoted to admin',
  federated_user_password_managed_by_home: 'Federated users authenticate via their home instance',
  last_admin_cannot_be_demoted: 'Cannot demote the last admin',
  admin_cannot_delete_self: 'Use account settings to delete your own account',
  user_owns_spaces: 'User owns spaces. Transfer ownership first',
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
