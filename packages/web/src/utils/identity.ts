import type { User } from '@backspace/shared';

/**
 * Splits a potentially federated username into base name and domain.
 * "youruser@nova.ddns.net" → { baseName: "youruser", domain: "nova.ddns.net" }
 * "youruser"                → { baseName: "youruser", domain: null }
 */
export function parseFederatedUsername(username: string): { baseName: string; domain: string | null } {
  const atIndex = username.indexOf('@');
  if (atIndex === -1) return { baseName: username, domain: null };
  return { baseName: username.slice(0, atIndex), domain: username.slice(atIndex + 1) };
}

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
  const { baseName } = parseFederatedUsername(user.username);
  return baseName === homeUser.username;
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

/**
 * Federation-safe check: do two user-like objects represent the same person?
 * Uses cascading strategies to handle missing homeUserId on old replicated users.
 */
export function canonicalUserMatch(
  a: { id: string; username: string; homeUserId?: string | null; homeInstance?: string | null },
  b: { id: string; username: string; homeUserId?: string | null; homeInstance?: string | null },
): boolean {
  // 1. Same local ID (same instance)
  if (a.id === b.id) return true;

  // 2. homeUserId cross-matching
  if (a.homeUserId && b.homeUserId && a.homeUserId === b.homeUserId) return true;
  if (a.homeUserId && a.homeUserId === b.id) return true;
  if (b.homeUserId && b.homeUserId === a.id) return true;

  // 3. Username + home instance fallback (mirrors isSelf resilience)
  const aBase = parseFederatedUsername(a.username);
  const bBase = parseFederatedUsername(b.username);
  if (aBase.baseName !== bBase.baseName) return false;

  const aHome = a.homeInstance ?? aBase.domain ?? null;
  const bHome = b.homeInstance ?? bBase.domain ?? null;

  if (!aHome && !bHome) return true;                    // Both native to home instance
  if (!aHome) return bHome === window.location.host;     // a native, b federated
  if (!bHome) return aHome === window.location.host;     // b native, a federated
  return aHome === bHome;                                // Both have explicit homes
}
