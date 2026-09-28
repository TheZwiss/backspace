import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { sanitizeUser } from '../../utils/sanitize.js';
import { collectProfileBroadcastTargetIds } from '../../utils/userDeletion.js';
import { connectionManager } from '../../ws/handler.js';

type UserRow = typeof schema.users.$inferSelect;
type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';

/** The password hash every replicated row carries; bcrypt never produces it. */
const REPLICATED_PASSWORD_HASH = '!federation-replicated';

/**
 * A home username, lowercased as replicated names are. Registration has
 * accepted only `[a-zA-Z0-9_]` since the first release (auth.ts), so a local
 * part with any other character (a space, a dot, a dash, a letter outside
 * ASCII, an `@`) is certainly not a handle.
 */
const HANDLE = /^[a-z0-9_]+$/;

/**
 * The replicated-name local part a username hint stands for: the hint
 * trimmed and lowercased when it is handle-shaped (`HANDLE`), else null.
 * Creation and rename both read hints through this, so a display name or any
 * other non-handle never becomes a row's name.
 */
export function handleFromHint(username: string | null | undefined): string | null {
  const handle = username?.trim().toLowerCase();
  return handle && HANDLE.test(handle) ? handle : null;
}

/** Most `_<n>` suffixes tried before a random one (`firstFreeUsername`). */
const MAX_NUMBERED_SUFFIX = 10;

/**
 * The part of a replicated row's username before `@<homeInstance>`, or null
 * when the username does not end with the row's own domain.
 */
function localPartOf(user: UserRow): string | null {
  if (!user.homeInstance) return null;
  const suffix = `@${user.homeInstance}`.toLowerCase();
  const username = user.username.toLowerCase();
  if (!username.endsWith(suffix)) return null;
  return username.slice(0, username.length - suffix.length);
}

/**
 * Whether a row is a replicated stub whose username is a placeholder, not
 * its home handle. Two kinds exist:
 *   - `<homeUserId>@<domain>`: the name `resolveOrCreateReplicatedUser` gives
 *     a remote user it meets without knowing their username;
 *   - a local part that is not handle-shaped (`HANDLE`), such as
 *     `<display name>@<domain>`, which incoming calls created before the call
 *     relay stopped passing the caller's display name as the username.
 * Only such a row is ever renamed. A placeholder that happens to be shaped
 * like a handle (a display name such as "kai") cannot be told apart from a
 * real handle here and is left alone.
 *
 * Excluded, and so never renamed:
 *   - native rows and rows without a home id (nothing to compare);
 *   - rows with their own login credentials (a federated account signs in with
 *     its username, so renaming it would change the login);
 *   - detached rows (`federationHomeOrphaned = 1`): the home domain now belongs
 *     to another incarnation, which never names an established account.
 */
export function isPlaceholderNamedStub(user: UserRow): boolean {
  if (!user.homeInstance || !user.homeUserId) return false;
  if (user.passwordHash !== REPLICATED_PASSWORD_HASH) return false;
  if (user.federationHomeOrphaned === 1) return false;
  const localPart = localPartOf(user);
  if (localPart === null) return false;
  return localPart === user.homeUserId.toLowerCase() || !HANDLE.test(localPart);
}

/**
 * The replicated username `<handle>@<domain>`, or, when another row holds it,
 * the first free `<handle>_<n>@<domain>` (n = 1..10), then a random suffix.
 * `ownerId` is the row the name is for; its own current name does not count
 * as taken. Creation and rename both name rows through this, so a handle
 * whose name is held (a username freed by an account deletion and registered
 * again, while this instance still holds the old replica) gets the same
 * suffixed name either way.
 */
export function firstFreeUsername(
  handle: string,
  domain: string,
  db: ReturnType<typeof getDb>,
  ownerId?: string,
): string {
  const isTaken = (candidate: string): boolean => {
    const holder = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.username, candidate))
      .get();
    return holder !== undefined && holder.id !== ownerId;
  };
  let username = `${handle}@${domain}`.toLowerCase();
  let attempt = 0;
  while (isTaken(username)) {
    attempt++;
    if (attempt > MAX_NUMBERED_SUFFIX) {
      return `${handle}_${randomBytes(4).toString('hex')}@${domain}`.toLowerCase();
    }
    username = `${handle}_${attempt}@${domain}`.toLowerCase();
  }
  return username;
}

/**
 * What the rename may seed besides the username. The stub backfill passes the
 * home's lookup answer. Identity resolution and hydration pass nothing:
 * hydration fills `displayName` itself (fill-empty), so seeding it here from
 * the bare username would keep the real display name out.
 */
export interface StubRenameSeed {
  displayName?: string | null;
  status?: UserStatus | null;
}

/**
 * Rename a placeholder-named stub (`isPlaceholderNamedStub`) to
 * `<username>@<domain>`, where `username` is the handle the row's home
 * reports, and return the row as written. Home usernames never change, so
 * this happens at most once per row. Every other row, and every `username`
 * that is not handle-shaped, is returned unchanged (the same object).
 *
 * When another row already holds the name, the stub takes the first free
 * suffixed name (`firstFreeUsername`), as creation does. With a `seed`, an
 * empty `displayName` is filled with `seed.displayName ?? username` and a
 * differing `status` is taken over.
 *
 * Announces nothing: `renamePlaceholderNamedStub` does, and hydration
 * announces once after it has filled the profile.
 */
export function applyPlaceholderRename(
  user: UserRow,
  username: string | null | undefined,
  db: ReturnType<typeof getDb>,
  seed?: StubRenameSeed,
): UserRow {
  if (!isPlaceholderNamedStub(user) || !user.homeInstance) return user;
  const handle = handleFromHint(username);
  if (!handle) return user;

  const newUsername = firstFreeUsername(handle, user.homeInstance, db, user.id);
  if (newUsername === user.username) return user;

  const updates: { username: string; displayName?: string; status?: UserStatus } = { username: newUsername };
  if (seed) {
    if (!user.displayName) updates.displayName = seed.displayName ?? handle;
    if (seed.status && seed.status !== user.status) updates.status = seed.status;
  }

  db.update(schema.users)
    .set(updates)
    .where(eq(schema.users.id, user.id))
    .run();
  console.log(`[federation] Renamed stub ${user.id}: ${user.username} -> ${newUsername}`);
  return { ...user, ...updates };
}

/**
 * Send `user_updated` with the row to every local user who can see it
 * (friends, DM partners, shared space members;
 * `collectProfileBroadcastTargetIds`), as `processProfileUpdateEvent` does, so
 * open clients show the change without a reload.
 */
export function announceUserUpdated(user: UserRow): void {
  const userUpdatedEvent = { type: 'user_updated' as const, user: sanitizeUser(user, false) };
  for (const uid of collectProfileBroadcastTargetIds(user.id)) {
    connectionManager.sendToUser(uid, userUpdatedEvent);
  }
}

/**
 * `applyPlaceholderRename`, then `announceUserUpdated` when the row was
 * renamed. For callers that do not hydrate the row afterwards (identity
 * resolution, the stub backfill); a caller that hydrates next announces again
 * once the profile is filled.
 */
export function renamePlaceholderNamedStub(
  user: UserRow,
  username: string | null | undefined,
  db: ReturnType<typeof getDb>,
  seed?: StubRenameSeed,
): UserRow {
  const renamed = applyPlaceholderRename(user, username, db, seed);
  if (renamed !== user) announceUserUpdated(renamed);
  return renamed;
}
