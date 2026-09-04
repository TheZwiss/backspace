/**
 * Stable error codes shared by the server and every client.
 *
 * The server never localizes. It sends one of these codes alongside an
 * English `error` string, and the client that shows the message owns the
 * words. The English text exists for logs and for clients that predate the
 * code; the code exists so a Russian or German client can say it properly.
 *
 * Codes are snake_case identifiers and never change meaning once shipped:
 * the desktop app, the web client and every federated peer version
 * independently, and an old client that meets a new code falls back to the
 * English text, so removing or repurposing one is a wire-protocol break.
 *
 * Adding a code: append it here, give it English text in
 * `packages/server/src/utils/httpErrors.ts`, and give it a message in every
 * `packages/web/src/locales/<lng>/errors.json`. The i18n consistency check
 * fails when a code has no catalog entry.
 */
export const ERROR_CODES = [
  // Generic
  'not_found',
  'forbidden',
  'unauthorized',
  'validation_failed',
  'rate_limited',

  // Auth and accounts
  'username_required',
  'password_required',
  'username_invalid',
  'username_too_long',
  'username_taken',
  'password_too_short',
  'password_too_long',
  'invalid_credentials',
  'registration_closed',
  'invite_required',
  'invite_invalid',
  'current_password_incorrect',
  'password_unchanged',
  'display_name_too_long',
  'bio_too_long',
  'custom_status_too_long',
  'profile_managed_by_home',
  'account_deletion_blocked_owned_spaces',
  'account_deletion_password_incorrect',

  // Social
  'cannot_friend_self',
  'user_not_found',
  'already_friends',
  'incoming_request_exists',
  'invalid_target_domain',
  'lookup_rate_limited',
  'not_authoritative_for_sender',

  // Federation and peering
  'peer_rejected',
  'peer_pending',
  'peer_pending_approval',
  'peer_pending_local_admin',
  'peer_unreachable',
  'PEER_EXISTS_RESET_REQUIRED',

  // Direct messages
  'recipient_deleted',

  // social-explore
  'friend_request_pending',
  'friend_request_not_found',
  'friend_request_not_recipient',
  'friend_request_not_sender',
  'friend_request_not_pending',
  'not_friends',
  'peer_reset_pending',
  'lookup_failed',
  'space_not_found',
  'space_not_public',
  'space_not_requestable',
  'space_load_failed',
  'user_banned',
  'already_member',
  'missing_permission',
  'join_request_pending',
  'join_request_not_found',
  'join_request_decided',
  // spaces
  'space_name_required',
  'space_name_length',
  'space_create_failed',
  'not_space_member',
  'avatar_color_invalid',
  'space_visibility_invalid',
  'no_fields_to_update',
  'space_update_failed',
  'space_owner_only',
  'space_uses_join_requests',
  'invite_code_required',
  'invite_not_found',
  'join_request_required',
  'cannot_change_own_roles',
  'role_ids_invalid',
  'member_not_found',
  'role_not_in_space',
  'everyone_role_not_assignable',
  'member_update_failed',
  'space_owner_cannot_leave',
  'cannot_target_owner',
  'cannot_target_self',
  'permissions_invalid',
  'role_name_taken',
  'role_name_required',
  'everyone_role_not_deletable',
  'new_owner_required',
  'already_owner',
  'new_owner_not_member',
  'ownership_transfer_failed',
  'user_id_required',
  'already_banned',
  'ban_not_found',
  // channels-messages
  'channel_not_found',
  'category_not_found',
  'message_not_found',
  'channel_name_required',
  'channel_name_length',
  'channel_type_invalid',
  'category_not_in_space',
  'channel_not_in_space',
  'position_invalid',
  'override_target_invalid',
  'override_target_required',
  'override_bits_invalid',
  'cannot_grant_unowned_permissions',
  'cannot_deny_unowned_permissions',
  'category_name_required',
  'category_name_length',
  'layout_arrays_required',
  'message_empty',
  'content_required',
  'content_too_long',
  'reply_target_invalid',
  'attachment_invalid',
  'attachment_not_owned',
  'message_edit_not_author',
  'message_delete_forbidden',
  'internal_error',
  // misc
  'not_dm_member',
  'voice_disabled',
  'voice_connect_forbidden',
  'file_not_found',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

/** Interpolation values for the localized message, e.g. `{ max: 32 }`. */
export type ErrorDetails = Record<string, string | number>;

/**
 * The body of every non-2xx JSON response.
 *
 * `error` is always present. `code` and `details` are optional because
 * routes are converted to codes surface by surface, and because a federated
 * peer may run a version that has never heard of them.
 */
export interface ApiErrorBody {
  error: string;
  statusCode: number;
  code?: ErrorCode;
  details?: ErrorDetails;
}
