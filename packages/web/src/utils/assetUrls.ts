import { getApiForOrigin } from '../stores/spaceStore';

/** Strip /api/uploads/ prefix to get bare filename. No-op for bare filenames and absolute URLs. */
export function stripUploadPrefix(filename: string): string {
  return filename.startsWith('/api/uploads/') ? filename.slice('/api/uploads/'.length) : filename;
}

/**
 * Resolve a relative asset filename to an absolute URL for remote origins.
 * Home-origin filenames are returned as-is (components handle the /api/uploads/ prefix).
 * Already-absolute URLs (starting with 'http') pass through unchanged.
 */
export function resolveAssetUrl(filename: string | null | undefined, origin: string): typeof filename {
  if (!filename || !origin || filename.startsWith('http')) return filename;
  return getApiForOrigin(origin).uploads.url(stripUploadPrefix(filename));
}

/**
 * Rewrite the avatar field on a user-like object for remote origins.
 * Mutates in-place for efficiency (called on arrays of members/messages).
 */
export function normalizeUserAssets<T extends { avatar?: string | null; banner?: string | null }>(user: T, origin: string): T {
  if (!origin) return user;
  if (user.avatar) {
    user.avatar = resolveAssetUrl(user.avatar, origin) ?? user.avatar;
  }
  if (user.banner) {
    user.banner = resolveAssetUrl(user.banner, origin) ?? user.banner;
  }
  // Qualify users local to the remote instance with their origin domain.
  // These users have no homeInstance (they're native there), so the client
  // can't distinguish them from its own local users without this step.
  const u = user as Record<string, unknown>;
  if (typeof u.username === 'string' && typeof u.id === 'string' && !u.homeInstance) {
    try {
      const host = new URL(origin).host;
      u.homeInstance = host;
      if (!u.homeUserId) u.homeUserId = u.id;
      if (!(u.username as string).includes('@')) {
        u.username = `${u.username}@${host}`;
      }
    } catch {}
  }
  return user;
}

/**
 * Rewrite user.avatar and attachment filenames on a message for remote origins.
 * Also normalizes nested replyTo message assets. Mutates in-place.
 */
export function normalizeMessageAssets<T extends { user: { avatar?: string | null }; attachments?: { filename: string; thumbnailFilename?: string | null }[]; replyTo?: { user: { avatar?: string | null }; attachments?: { filename: string; thumbnailFilename?: string | null }[] } | null }>(
  message: T,
  origin: string,
): T {
  if (!origin) return message;
  normalizeUserAssets(message.user, origin);
  if (message.attachments) {
    for (const att of message.attachments) {
      att.filename = resolveAssetUrl(att.filename, origin) ?? att.filename;
      if (att.thumbnailFilename) {
        att.thumbnailFilename = resolveAssetUrl(att.thumbnailFilename, origin) ?? att.thumbnailFilename;
      }
    }
  }
  // Normalize reply-to message assets (remote replies have relative URLs)
  if (message.replyTo) {
    normalizeUserAssets(message.replyTo.user, origin);
    if (message.replyTo.attachments) {
      for (const att of message.replyTo.attachments) {
        att.filename = resolveAssetUrl(att.filename, origin) ?? att.filename;
        if (att.thumbnailFilename) {
          att.thumbnailFilename = resolveAssetUrl(att.thumbnailFilename, origin) ?? att.thumbnailFilename;
        }
      }
    }
  }
  return message;
}
