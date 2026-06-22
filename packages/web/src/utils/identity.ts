import type { User } from '@backspace/shared';

/**
 * Splits a potentially federated username into base name and domain.
 * "erin@nova.ddns.net" → { baseName: "erin", domain: "nova.ddns.net" }
 * "erin"                → { baseName: "erin", domain: null }
 */
export function parseFederatedUsername(username: string): { baseName: string; domain: string | null } {
  const atIndex = username.indexOf('@');
  if (atIndex === -1) return { baseName: username, domain: null };
  return { baseName: username.slice(0, atIndex), domain: username.slice(atIndex + 1) };
}

// ─── Cross-instance self-ID registry ─────────────────────────────────────────
// Tracks all Snowflake IDs that belong to the current user across connected
// instances (home + remotes). Populated from WS `ready` events.

const _knownSelfIds = new Set<string>();

export function registerSelfId(id: string): void {
  _knownSelfIds.add(id);
}

export function clearSelfIds(): void {
  _knownSelfIds.clear();
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
  // Cross-instance: check all known user IDs from connected instances
  if (_knownSelfIds.has(user.id)) return true;
  // Replicated user: homeInstance matches our origin
  if (!user.homeInstance) return false;
  if (user.homeInstance !== window.location.host) return false;
  // Username: "erin" or "erin@nova.ddns.net" → base must match
  const { baseName } = parseFederatedUsername(user.username);
  const { baseName: homeBase } = parseFederatedUsername(homeUser.username);
  return baseName === homeBase;
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

// ─── Cross-instance origin / canonical-identity helpers ─────────────────────
// Used by the userViews cache (spaceStore) and any code that needs to compare
// a user's home instance against a delivering connection's origin. Bare-domain
// `users.home_instance` and full-URL connection origins must always agree
// through these helpers — never via ad-hoc string comparisons.

/**
 * Extract the bare host from a delivering-origin string.
 *
 *   ''                       → ''   (the empty-origin sentinel for "home connection")
 *   null / undefined         → ''
 *   'https://nova.ddns.net' → 'nova.ddns.net'
 *   'http://localhost:3000'  → 'localhost:3000'
 *   'nova.ddns.net'         → 'nova.ddns.net'
 *
 * Empty inputs return `''`. Use {@link deliveringHost} when you need the
 * concrete host that an origin represents (which substitutes
 * `window.location.host` for the empty sentinel).
 */
export function normalizeOriginToHost(input: string | null | undefined): string {
  if (!input) return '';
  if (input.includes('://')) {
    try {
      return new URL(input).host;
    } catch {
      return '';
    }
  }
  return input;
}

/**
 * Resolve a delivering origin to its concrete host. Substitutes
 * `window.location.host` for the empty-origin sentinel (`''` = our home
 * connection). All other inputs are normalized via {@link normalizeOriginToHost}.
 */
function deliveringHost(origin: string): string {
  if (origin === '') return typeof window === 'undefined' ? '' : window.location.host;
  return normalizeOriginToHost(origin);
}

/**
 * Stable cross-instance cache key for a user.
 *
 * Federated user: `<homeInstanceHost>:<homeUserId>` — same key for the same
 * person regardless of which instance's local stub we're holding.
 *
 * Purely local user: `:<id>` (homeInstance and homeUserId are null) — local
 * users never collide with federated keys because the host segment is empty.
 *
 * Defensive fallback: if homeInstance is set but homeUserId is missing
 * (legacy stubs from before homeUserId was populated), the local id is used
 * as the identifier portion. This is rare and self-corrects when fresh
 * profile data arrives.
 */
export function canonicalUserKey(
  user: { id: string; homeUserId?: string | null; homeInstance?: string | null },
): string {
  const host = normalizeOriginToHost(user.homeInstance);
  const ident = user.homeUserId ?? user.id;
  return `${host}:${ident}`;
}

/**
 * True iff the delivering origin is the user's home — i.e. the receiving
 * payload contains the authoritative view of this user.
 *
 * Cases:
 *  - `user.homeInstance` is null/empty: the user is native to whatever
 *    instance delivered them. Always a home view.
 *  - `user.homeInstance` is set: home view iff the delivering host equals
 *    the user's home host (with `''` resolving to `window.location.host`).
 *
 * Used as the "isHome" tier in the userViews preference rule. Stub views
 * never overwrite home views; home views always upgrade stubs.
 */
export function isDeliveryFromHome(
  user: { homeInstance?: string | null },
  deliveringOrigin: string,
): boolean {
  const dh = deliveringHost(deliveringOrigin);
  const uh = user.homeInstance ? normalizeOriginToHost(user.homeInstance) : dh;
  return uh === dh;
}

/**
 * Should the federation-globe indicator render for this user, from the
 * current client's perspective?
 *
 * True iff the user is genuinely remote: their username carries an `@domain`
 * suffix AND that domain is NOT our own host. Catches the bug where a stub
 * delivered by a sibling instance (e.g. orbit-side `frank@nova.ddns.net`
 * viewed from a session logged in to nova) would otherwise show the globe.
 *
 * Compose with {@link useCanonicalUserView} at render sites: resolve the
 * canonical view first, then run this predicate so the answer reflects the
 * best-known view of the user, not whichever stub the carrying channel
 * happened to land on.
 */
export function isFederationGlobeApplicable(
  user: { username: string },
): boolean {
  const { domain } = parseFederatedUsername(user.username);
  if (!domain) return false;
  if (typeof window === 'undefined') return true; // SSR fallback
  return domain !== window.location.host;
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
