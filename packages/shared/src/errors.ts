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

  // misc
  'channel_not_found',
  'message_not_found',
  'not_dm_member',
  'missing_permission',
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
