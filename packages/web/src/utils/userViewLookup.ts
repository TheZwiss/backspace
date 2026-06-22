import type { User } from '@backspace/shared';
import { useSpaceStore } from '../stores/spaceStore';
import { canonicalUserKey } from './identity';

/**
 * Synchronous lookup into the userViews cache. Returns the best-known view of
 * the user from any connected origin, or the input unchanged on cache miss.
 *
 * Use from non-React paths (event handlers, helpers, predicates). React
 * render sites should use {@link useCanonicalUserView} so subscriptions tick
 * when the cache updates.
 *
 * Pass User-shaped inputs. Returning the cache entry replaces the input
 * reference; callers that depend on extra fields (UI-augmented types) should
 * either route the input through this helper before extending it, or call
 * with the underlying User and re-augment.
 */
export function getCanonicalUserView(user: User): User {
  const key = canonicalUserKey(user);
  const entry = useSpaceStore.getState().userViews.get(key);
  return entry ? entry.user : user;
}

/**
 * Reactive lookup into the userViews cache. Subscribes to the specific cache
 * entry so the calling component re-renders when an upsert lands a better
 * view (e.g. nova's home view of Frank arriving after orbit's stub
 * populated the cache first). Returns the input unchanged on cache miss; the
 * site falls back to the current best information until the cache fills.
 *
 * Composes with `isSelf` / `resolveDisplayIdentity` rather than replacing
 * them — call those for self-detection / self-rendering as before, and pass
 * non-self users through this hook for cross-instance view resolution.
 */
export function useCanonicalUserView(user: User): User {
  const key = canonicalUserKey(user);
  const entry = useSpaceStore((state) => state.userViews.get(key));
  return entry ? entry.user : user;
}
