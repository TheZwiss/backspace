import { getApiForOrigin } from '../stores/serverStore';

/**
 * Resolve a relative asset filename to an absolute URL for remote origins.
 * Home-origin filenames are returned as-is (components handle the /api/uploads/ prefix).
 * Already-absolute URLs (starting with 'http') pass through unchanged.
 */
export function resolveAssetUrl(filename: string | null | undefined, origin: string): typeof filename {
  if (!filename || !origin || filename.startsWith('http')) return filename;
  return getApiForOrigin(origin).uploads.url(filename);
}

/**
 * Rewrite the avatar field on a user-like object for remote origins.
 * Mutates in-place for efficiency (called on arrays of members/messages).
 */
export function normalizeUserAssets<T extends { avatar?: string | null }>(user: T, origin: string): T {
  if (origin && user.avatar) {
    user.avatar = resolveAssetUrl(user.avatar, origin) ?? user.avatar;
  }
  return user;
}

/**
 * Rewrite user.avatar and attachment filenames on a message for remote origins.
 * Mutates in-place.
 */
export function normalizeMessageAssets<T extends { user: { avatar?: string | null }; attachments?: { filename: string }[] }>(
  message: T,
  origin: string,
): T {
  if (!origin) return message;
  normalizeUserAssets(message.user, origin);
  if (message.attachments) {
    for (const att of message.attachments) {
      att.filename = resolveAssetUrl(att.filename, origin) ?? att.filename;
    }
  }
  return message;
}
