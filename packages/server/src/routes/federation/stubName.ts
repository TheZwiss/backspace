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

/** Most `~<n>` suffixes tried before a random one (`firstFreeUsername`). */
const MAX_NUMBERED_SUFFIX = 10;

/**
 * The separator between a handle and its collision suffix. It is outside the
 * handle alphabet (`HANDLE`), so a suffixed name can never be the real handle
 * of another user of the same instance, and a row carrying one is recognizable
 * as suffixed. `_` was used before: `kai_1` could shadow a later real `kai_1`.
 */
const SUFFIX_SEPARATOR = '~';

/**
 * A suffixed local part: the handle, `SUFFIX_SEPARATOR`, then the number or
 * random hex `firstFreeUsername` appended.
 */
const SUFFIXED_LOCAL_PART = /^([a-z0-9_]+)~([0-9a-f]+)$/;

/** The handle a suffixed local part (`kai~1`) was named after, else null. */
function suffixedHandleOf(localPart: string): string | null {
  return SUFFIXED_LOCAL_PART.exec(localPart)?.[1] ?? null;
}

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
 * Whether a row is a replicated row this instance names itself and may
 * rename: it has a home id, no login credentials of its own, and is not
 * detached.
 *   - Native rows and rows without a home id have nothing to compare.
 *   - A federated account signs in with its username, so renaming it would
 *     change the login.
 *   - A detached row (`federationHomeOrphaned = 1`): the home domain now
 *     belongs to another incarnation, which never names an established account.
 */
function isRenameableReplica(user: UserRow): boolean {
  if (!user.homeInstance || !user.homeUserId) return false;
  if (user.passwordHash !== REPLICATED_PASSWORD_HASH) return false;
  return user.federationHomeOrphaned !== 1;
}

/**
 * Whether a row is a replicated stub whose username is a placeholder, not
 * its home handle. Two kinds exist:
 *   - `<homeUserId>@<domain>`: the name `resolveOrCreateReplicatedUser` gives
 *     a remote user it meets without knowing their username;
 *   - a local part that is not handle-shaped (`HANDLE`), such as
 *     `<display name>@<domain>`, which incoming calls created before the call
 *     relay stopped passing the caller's display name as the username.
 * A placeholder that happens to be shaped like a handle (a display name such
 * as "kai") cannot be told apart from a real handle here and is left alone. A
 * suffixed name (`kai~1`, see `firstFreeUsername`) is not a placeholder: the
 * row's handle is known, and only a hint with that handle re-checks it
 * (`applyPlaceholderRename`).
 *
 * Only a row that may be renamed at all (`isRenameableReplica`: a replica
 * with a home id, no login credentials, not detached) is ever a placeholder.
 */
export function isPlaceholderNamedStub(user: UserRow): boolean {
  if (!isRenameableReplica(user) || !user.homeUserId) return false;
  const localPart = localPartOf(user);
  if (localPart === null) return false;
  if (suffixedHandleOf(localPart) !== null) return false;
  return localPart === user.homeUserId.toLowerCase() || !HANDLE.test(localPart);
}

/**
 * Whether a row carries a suffixed name (`<handle>~<n>@<domain>`) given for
 * `handle` while another row held `<handle>@<domain>`. Such a row is
 * re-checked when its home reports that handle again, and moves to an earlier
 * free name once the holder is gone.
 */
function isSuffixedFor(user: UserRow, handle: string): boolean {
  if (!isRenameableReplica(user)) return false;
  const localPart = localPartOf(user);
  return localPart !== null && suffixedHandleOf(localPart) === handle;
}

/**
 * The replicated username `<handle>@<domain>`, or, when another row holds it,
 * the first free `<handle>~<n>@<domain>` (n = 1..10), then a random
 * `<handle>~<hex>@<domain>`. The suffix separator is not a handle character
 * (`SUFFIX_SEPARATOR`), so a suffixed name never shadows a real handle.
 * `owner` is the row the name is for: its own current name does not count as
 * taken, and when every numbered name is held it keeps a random name it
 * already has for this handle instead of drawing a new one. So a row asked
 * again only ever moves to an earlier name, which makes the rename stable.
 * Creation and rename both name rows through this, so a handle whose name is
 * held (a username freed by an account deletion and registered again, while
 * this instance still holds the old replica) gets the same suffixed name
 * either way.
 */
export function firstFreeUsername(
  handle: string,
  domain: string,
  db: ReturnType<typeof getDb>,
  owner?: Pick<UserRow, 'id' | 'username'>,
): string {
  const isTaken = (candidate: string): boolean => {
    const holder = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.username, candidate))
      .get();
    return holder !== undefined && holder.id !== owner?.id;
  };
  const nameFor = (localPart: string): string => `${localPart}@${domain}`.toLowerCase();
  let username = nameFor(handle);
  let attempt = 0;
  while (isTaken(username)) {
    attempt++;
    if (attempt > MAX_NUMBERED_SUFFIX) {
      const ownName = owner?.username.toLowerCase();
      const ownSuffix = `@${domain}`.toLowerCase();
      if (ownName?.endsWith(ownSuffix)
        && suffixedHandleOf(ownName.slice(0, ownName.length - ownSuffix.length)) === handle) {
        return ownName;
      }
      return nameFor(`${handle}${SUFFIX_SEPARATOR}${randomBytes(4).toString('hex')}`);
    }
    username = nameFor(`${handle}${SUFFIX_SEPARATOR}${attempt}`);
  }
  return username;
}

/**
 * Whether two rows are the same federated identity: the same `homeUserId` at
 * the same home domain.
 */
function isSameIdentity(
  a: Pick<UserRow, 'homeUserId' | 'homeInstance'>,
  b: Pick<UserRow, 'homeUserId' | 'homeInstance'>,
): boolean {
  if (!a.homeUserId || !a.homeInstance || !b.homeUserId || !b.homeInstance) return false;
  return a.homeUserId === b.homeUserId && a.homeInstance.toLowerCase() === b.homeInstance.toLowerCase();
}

/** What `claimHandleName` did. */
export type HandleClaim =
  /**
   * The row is named `username` now. `moved` is the replica that held the
   * name and moved aside, as written, for the caller to announce.
   */
  | { kind: 'claimed'; username: string; moved: UserRow | null }
  /** Another account signs in with the name, or a replica of the same identity holds it. */
  | { kind: 'held'; holderId: string };

/**
 * Name a login row (a federated account: it signs in with its username) after
 * its home handle, exactly `<handle>@<domain>`. The client signs in to another
 * instance as `<handle>@<home>` and registers that name when no row has it, so
 * any other name locks the owner out of automatic sign-in and lets a second
 * row for the same identity be registered.
 *
 * Only a replica can make room, and only a replica of another identity (a
 * stale replica of an account deleted on its home whose handle was registered
 * again): it moves to the first free suffixed name for the handle
 * (`firstFreeUsername`), which its own home's hints re-check later. A name
 * another login row holds, or a replica of this same identity holds (two rows
 * for one identity; only the proof-gated re-attach merge absorbs such a
 * replica), is left alone and reported as `held`.
 *
 * `handle` must be handle-shaped (`handleFromHint`); callers read the home's
 * answer through it first. Writes without a transaction of its own, so a
 * caller that must not keep a half-done rename runs it inside one. Logs each
 * rename. Announces nothing.
 */
export function claimHandleName(
  row: UserRow,
  handle: string,
  domain: string,
  db: ReturnType<typeof getDb>,
): HandleClaim {
  if (!HANDLE.test(handle)) throw new Error(`claimHandleName: "${handle}" is not a handle`);
  const username = `${handle}@${domain}`.toLowerCase();
  let moved: UserRow | null = null;

  const holder = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (holder && holder.id !== row.id) {
    if (holder.passwordHash !== REPLICATED_PASSWORD_HASH || isSameIdentity(holder, row)) {
      return { kind: 'held', holderId: holder.id };
    }
    // No owner: the holder's own name counts as taken, so it moves to a
    // suffixed name for the handle.
    const aside = firstFreeUsername(handle, domain, db);
    db.update(schema.users).set({ username: aside }).where(eq(schema.users.id, holder.id)).run();
    console.log(`[federation] Moved replica ${holder.id}: ${holder.username} -> ${aside} (account ${row.id} takes its handle)`);
    moved = { ...holder, username: aside };
  }

  if (row.username !== username) {
    db.update(schema.users).set({ username }).where(eq(schema.users.id, row.id)).run();
    console.log(`[federation] Renamed account ${row.id}: ${row.username} -> ${username} (its home handle)`);
  }
  return { kind: 'claimed', username, moved };
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
 * Name a replicated row after the handle its home reports (`username`) and
 * return the row as written. Two kinds of row are (re)named:
 *   - a placeholder-named stub (`isPlaceholderNamedStub`), with any handle;
 *   - a row with a suffixed name for this same handle (`isSuffixedFor`),
 *     which moves to an earlier free name (the handle itself once its holder
 *     is gone) and otherwise keeps its name.
 * Every other row, and every `username` that is not handle-shaped, is
 * returned unchanged (the same object). Home usernames never change, so a
 * row's name only ever moves toward its handle, and no other row is touched:
 * the rename cannot loop between two rows.
 *
 * When another row already holds the name, the row takes the first free
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
  if (!user.homeInstance) return user;
  const handle = handleFromHint(username);
  if (!handle) return user;
  if (!isPlaceholderNamedStub(user) && !isSuffixedFor(user, handle)) return user;

  const newUsername = firstFreeUsername(handle, user.homeInstance, db, user);
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
