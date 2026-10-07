import type { User } from '@backspace/shared';
import { isMine, ownRowAt, selfIdentityOf, type IdentityFields, type SelfIdentity } from '../utils/identity';

/** The part of the auth state a test that replaces `stores/authStore` controls. */
export interface MockAuthState {
  user: (Partial<User> & IdentityFields) | null;
  /** The signed-in user's row id per connected instance; see `authStore.myRowIds`. */
  myRowIds?: Map<string, string>;
  [extra: string]: unknown;
}

/**
 * A stand-in for `stores/authStore` in tests that replace the module (to keep
 * the real store's imports out of the test). `read` returns the test's own
 * state object, which the test may change between cases. The "my ids"
 * readers (`getMyUserIdForOrigin`, `isMe`, `useSelfIdentity`,
 * `myRowForOrigin`) answer over it as the real ones do over the real store,
 * through the same pure `selfIdentityOf` / `isMine` / `ownRowAt`.
 *
 *   vi.mock('../stores/authStore', async () =>
 *     (await import('../test/authStoreMock')).authStoreMock(() => state));
 */
export function authStoreMock(read: () => MockAuthState) {
  const rowsOf = (): Map<string, string> => {
    const state = read();
    if (!state.myRowIds) state.myRowIds = new Map();
    return state.myRowIds;
  };
  const full = () => ({
    token: 't',
    trueHomeStatus: null,
    ...read(),
    myRowIds: rowsOf(),
    recordMyRow: (origin: string, userId: string) => { rowsOf().set(origin, userId); },
    forgetMyRow: (origin: string) => { rowsOf().delete(origin); },
  });
  const useAuthStore = Object.assign(
    (selector: (s: unknown) => unknown) => selector(full()),
    {
      getState: full,
      setState: (patch: Partial<MockAuthState>) => { Object.assign(read(), patch); },
      subscribe: () => () => {},
    },
  );
  // One object per state, as the real hook's memo gives, so effects that
  // depend on it do not re-run on every render.
  let cached: { user: MockAuthState['user']; rows: string; value: SelfIdentity | null } | null = null;
  const self = (): SelfIdentity | null => {
    const user = read().user;
    const rows = JSON.stringify([...rowsOf()]);
    if (!cached || cached.user !== user || cached.rows !== rows) {
      cached = { user, rows, value: selfIdentityOf(user, rowsOf()) };
    }
    return cached.value;
  };
  const myRow = (origin: string): MockAuthState['user'] => {
    const user = read().user;
    if (!user) return null;
    if (!origin) return user;
    const rowId = rowsOf().get(origin);
    return rowId ? ownRowAt(user, origin, rowId) : null;
  };
  return {
    useAuthStore,
    selectMyChosenStatus: () => null,
    useSelfIdentity: self,
    isMe: (row: IdentityFields, origin: string) => isMine(row, origin, self()),
    getMyUserIdForOrigin: (origin: string) => (origin ? rowsOf().get(origin) : read().user?.id),
    myRowForOrigin: myRow,
    useMyRowForOrigin: myRow,
  };
}
