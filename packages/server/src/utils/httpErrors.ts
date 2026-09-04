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
  already_member: 'You are already a member',
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
  // social-explore
  friend_request_pending: 'A friend request is already pending',
  friend_request_not_found: 'Friend request not found',
  friend_request_not_recipient: 'You can only manage requests sent to you',
  friend_request_not_sender: 'You can only cancel requests you sent',
  friend_request_not_pending: 'Can only cancel pending requests',
  not_friends: 'You are not friends with this user',
  lookup_failed: 'Looking up the user on the remote instance failed',
  space_not_found: 'Space not found',
  space_not_public: 'This space does not allow public joins',
  space_not_requestable: 'This space does not accept join requests',
  space_load_failed: 'Failed to load space',
  user_banned: 'You are banned from this space',
  missing_permission: 'Missing {{permission}} permission',
  join_request_pending: 'You already have a pending request for this space',
  join_request_not_found: 'Join request not found',
  join_request_decided: 'This request has already been decided',
  // spaces
  space_name_required: 'Space name is required',
  space_name_length: 'Space name must be between {{min}} and {{max}} characters',
  space_create_failed: 'Failed to create space',
  not_space_member: 'You are not a member of this space',
  avatar_color_invalid: 'Invalid avatar color',
  space_visibility_invalid: 'Visibility must be "public", "request", or "private"',
  no_fields_to_update: 'No fields to update',
  space_update_failed: 'Failed to update space',
  space_owner_only: 'Only the space owner can do that',
  space_uses_join_requests: 'Request-only spaces do not use invite links; entry is by join request',
  invite_code_required: 'Invite code is required',
  invite_not_found: 'Invalid invite code',
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
  new_owner_not_member: 'New owner must be a member of the space',
  ownership_transfer_failed: 'Failed to transfer ownership',
  user_id_required: 'userId is required',
  already_banned: 'User is already banned',
  ban_not_found: 'Ban not found',
  // channels-messages
  channel_not_found: 'Channel not found',
  category_not_found: 'Category not found',
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
  message_edit_not_author: 'You can only edit your own messages',
  message_delete_forbidden: 'You cannot delete this message',
  internal_error: 'Something went wrong on the server',
  // misc
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
