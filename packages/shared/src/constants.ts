// ─── Streaming Constants ─────────────────────────────────────────────────────

export const STANDARD_RESOLUTIONS = [540, 720, 1080, 1440, 2160] as const;
export type StandardResolution = (typeof STANDARD_RESOLUTIONS)[number];
export type Resolution = StandardResolution | 'native';

export const ALL_RESOLUTIONS: readonly Resolution[] = [...STANDARD_RESOLUTIONS, 'native'];

export const STANDARD_FRAMERATES = [30, 45, 60, 75, 90, 120] as const;
export type Framerate = (typeof STANDARD_FRAMERATES)[number];

export const WIDTH_MAP: Record<StandardResolution, number> = {
  540: 960,
  720: 1280,
  1080: 1920,
  1440: 2560,
  2160: 3840,
};

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  540: '540p',
  720: '720p',
  1080: '1080p',
  1440: '1440p',
  2160: '4K',
  native: 'Native',
};

export const HIGH_END_RESOLUTION_THRESHOLD = 1440;
export const HIGH_END_FRAMERATE_THRESHOLD = 75;

// Hand-tuned VP9 screen share bitrates in kbps per resolution/framerate combo.
// All bitrate math operates in kbps; conversion to bps happens only at the WebRTC encoding boundary.
export const BITRATE_MATRIX_KBPS: Record<number, Record<number, number>> = {
  540:  { 30: 1500, 45: 2000, 60: 2500, 75: 2800, 90: 3200, 120: 4000 },
  720:  { 30: 3000, 45: 3500, 60: 4000, 75: 4500, 90: 5000, 120: 6000 },
  1080: { 30: 6000, 45: 7000, 60: 8000, 75: 9000, 90: 10000, 120: 12000 },
  1440: { 30: 10000, 45: 12000, 60: 14000, 75: 16000, 90: 18000, 120: 22000 },
  2160: { 30: 20000, 45: 24000, 60: 28000, 75: 32000, 90: 38000, 120: 45000 },
};

// ─── Channel Constants ───────────────────────────────────────────────────────

export const CHANNEL_NAME_MIN_LENGTH = 1;
export const CHANNEL_NAME_MAX_LENGTH = 100;

/**
 * The form a space channel name is stored in: trimmed, lowercased, each run of
 * whitespace replaced by one dash. The server applies it on create and rename,
 * and the client applies it to tell whether an edited name changes anything.
 */
export function normalizeChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * The longest channel topic (the channel's description) the server stores,
 * counted in UTF-16 code units after `normalizeChannelTopic`, the same unit a
 * textarea's `maxLength` counts in. Longer topics are refused, never cut.
 */
export const CHANNEL_TOPIC_MAX_LENGTH = 1024;

/**
 * The form a channel topic is stored in: line endings unified to `\n` and the
 * whole value trimmed. A topic that trims to nothing is stored as `null`, which
 * is also how a topic is cleared. The server applies it on create and update,
 * and the client applies it to tell whether an edit changes anything and to
 * count characters the way the server will.
 */
export function normalizeChannelTopic(topic: string): string | null {
  const normalized = topic.replace(/\r\n?/g, '\n').trim();
  return normalized.length > 0 ? normalized : null;
}

export const CATEGORY_NAME_MIN_LENGTH = 1;
export const CATEGORY_NAME_MAX_LENGTH = 100;

/** The form a category name is stored in: trimmed, case and spacing kept. */
export function normalizeCategoryName(name: string): string {
  return name.trim();
}

// ─── Group DM Constants ──────────────────────────────────────────────────────

export const GROUP_DM_NAME_MAX_LENGTH = 50;
export const GROUP_DM_NAME_MIN_LENGTH = 1;
export const GROUP_DM_ICON_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
export const GROUP_DM_ICON_MIME_PREFIX = 'image/';

export const MAX_BOTS_PER_USER = 10;
/** Access tokens one bot may hold at once; each can be revoked on its own. */
export const MAX_BOT_TOKENS_PER_BOT = 5;
/** Longest owner label of a bot token. */
export const BOT_TOKEN_NAME_MAX_LENGTH = 32;
/**
 * WebSocket close code for a bot socket refused because another socket with the
 * same credential is open: a bot runs as one process for all of its channels.
 */
export const BOT_TOKEN_IN_USE_CLOSE_CODE = 4409;
export const BOT_NAME_SUFFIX = '_bot';
export const BOT_NAME_MIN_LENGTH = 5;
export const BOT_NAME_MAX_LENGTH = 32;
/**
 * The kinds of status an owner can set for a bot in Settings > Bots. A subset of
 * `ActivityType`: `streaming` needs a live URL, which a stored status has not.
 */
export const BOT_ACTIVITY_TYPES = ['custom', 'playing', 'listening', 'watching'] as const;
/** Longest value of a string option of a slash command, and the largest `maxLength` a bot may set. */
export const COMMAND_STRING_OPTION_MAX = 2000;

// ─── Account Constants ───────────────────────────────────────────────────────

/** Longest profile bio ("About me", a bot's "About"), in characters after trim. */
export const PROFILE_BIO_MAX_LENGTH = 190;

/**
 * The fewest characters a password may have. The server refuses a shorter one
 * at registration and password change (`password_too_short`, with this value
 * as `details.min`), and the client checks it before sending so its message
 * and the server's never disagree.
 */
export const PASSWORD_MIN_LENGTH = 8;

// ─── Space Nickname and Owner Title Constants ────────────────────────────────

/**
 * The longest space nickname (a member's name in one space, separate from the
 * account name), counted in UTF-16 code units after `normalizeMemberNickname`,
 * the same unit an input's `maxLength` counts in. Longer ones are refused.
 */
export const MAX_MEMBER_NICKNAME_LENGTH = 32;

/** Control characters, line and paragraph separators, and bidirectional embedding, override and isolate marks. */
const NICKNAME_FORBIDDEN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/** Characters that draw nothing: format characters (zero-width space, joiners), whitespace and the Hangul fillers. */
const NICKNAME_INVISIBLE = /[\p{Cf}\p{White_Space}\u115F\u1160\u3164\uFFA0]/gu;

/**
 * The form a space nickname is stored in, or `undefined` when the value is not
 * a nickname. `null`, and a string that trims to nothing, clear the nickname
 * (stored as null, so the account name shows). A nickname is trimmed and
 * refused when it is longer than MAX_MEMBER_NICKNAME_LENGTH, holds a control
 * character, a line break or a bidirectional control, or has no visible
 * character. The server applies it on `PATCH /api/spaces/:id/members/:uid`,
 * and the client applies it before sending so both refuse the same values.
 */
export function normalizeMemberNickname(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_MEMBER_NICKNAME_LENGTH) return undefined;
  return isVisibleSingleLine(trimmed) ? trimmed : undefined;
}

/**
 * Whether a trimmed, non-empty label may be shown as a name or heading: no
 * control character, line break or bidirectional control, and at least one
 * visible character. Shared by nicknames, owner titles and sticker names.
 */
export function isVisibleSingleLine(trimmed: string): boolean {
  if (NICKNAME_FORBIDDEN.test(trimmed)) return false;
  return trimmed.replace(NICKNAME_INVISIBLE, '').length > 0;
}

/**
 * The longest owner title (the heading over a space's owner in its member
 * list), counted in UTF-16 code units after `normalizeOwnerTitle`, the unit an
 * input's `maxLength` counts in.
 */
export const MAX_OWNER_TITLE_LENGTH = 32;

/**
 * The form an owner title is stored in, or `undefined` when the value is not
 * one. `null` resets the heading to the translated default. A string is
 * trimmed and refused when it trims to nothing, is longer than
 * MAX_OWNER_TITLE_LENGTH, or fails the rule nicknames follow (control
 * characters, line breaks, bidirectional controls, nothing visible). Unlike a
 * nickname, a blank title does not reset: only `null` does. The server applies
 * it on `PATCH /api/spaces/:id`, and the client applies it before sending.
 */
export function normalizeOwnerTitle(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_OWNER_TITLE_LENGTH) return undefined;
  return isVisibleSingleLine(trimmed) ? trimmed : undefined;
}
