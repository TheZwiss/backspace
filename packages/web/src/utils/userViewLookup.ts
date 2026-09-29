import type { User } from '@backspace/shared';
import { useSpaceStore, type UserViewEntry } from '../stores/spaceStore';
import { userKey } from './identity';

/**
 * How `row` looks at its best: the cached view of the same person
 * (`userKey(row, origin)`), with the row's own identity fields (`id`,
 * `homeUserId`, `homeInstance`) kept. The cache supplies how a person is
 * shown; the row, and the origin that issued it, stay what every request and
 * id comparison uses, so a caller never ends up holding one instance's id
 * paired with another instance's origin.
 */
function viewOf(row: User, entry: UserViewEntry | undefined): User {
  if (!entry || entry.user === row) return row;
  return { ...entry.user, id: row.id, homeUserId: row.homeUserId, homeInstance: row.homeInstance };
}

/**
 * Synchronous lookup into the userViews cache for `row` as `origin` issued it
 * (`''` = the page's own instance). Returns the input unchanged on a cache
 * miss.
 *
 * Use from non-React paths (event handlers, helpers, predicates). React
 * render sites use {@link useCanonicalUserView} so they re-render when the
 * cache updates.
 */
export function getCanonicalUserView(row: User, origin: string): User {
  return viewOf(row, useSpaceStore.getState().userViews.get(userKey(row, origin)));
}

/**
 * Reactive lookup into the userViews cache for `row` as `origin` issued it.
 * Subscribes to that person's entry, so the component re-renders when a
 * better view lands (e.g. nova's own view of Frank arriving after orbit's
 * copy of him filled the cache first). Returns the input unchanged on a miss.
 *
 * Whether the row is the signed-in user is a separate question, answered by
 * `isMine` / `isMe` (`stores/authStore.ts`).
 */
export function useCanonicalUserView(row: User, origin: string): User {
  const entry = useSpaceStore((state) => state.userViews.get(userKey(row, origin)));
  return viewOf(row, entry);
}
