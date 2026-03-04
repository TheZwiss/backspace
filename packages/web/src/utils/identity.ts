import type { User } from '@backspace/shared';

/**
 * Stateless check: is `user` a replicated alias of `homeUser`?
 * Uses the immutable (username, homeInstance) composite key —
 * no store lookups, no snowflake ID mapping.
 */
export function isSelf(
  user: { id: string; username: string; homeInstance?: string | null },
  homeUser: { id: string; username: string } | null,
): boolean {
  if (!homeUser) return false;
  // Same instance, same ID — trivial case
  if (user.id === homeUser.id) return true;
  // Replicated user: homeInstance matches our origin
  if (!user.homeInstance) return false;
  if (user.homeInstance !== window.location.host) return false;
  // Username: "youruser" or "youruser@nova.ddns.net" → base must match
  const baseUsername = user.username.split('@')[0];
  return baseUsername === homeUser.username;
}

/**
 * If `user` is a replicated alias of `homeUser`, return `homeUser`
 * for display purposes (avatar gradient, display name). Otherwise
 * return the original user unchanged. Data is never mutated.
 */
export function resolveDisplayIdentity(user: User, homeUser: User | null): User {
  if (!homeUser) return user;
  if (isSelf(user, homeUser)) return homeUser;
  return user;
}
