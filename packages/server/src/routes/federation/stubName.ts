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
 * Whether a row is a replicated stub still named `<homeUserId>@<domain>`: the
 * name `resolveOrCreateReplicatedUser` gives a remote user it meets without
 * knowing their username. Only such a row is ever renamed.
 *
 * Excluded, and so never renamed:
 *   - native rows and rows without a home id (nothing to compare);
 *   - rows with their own login credentials (a federated account signs in with
 *     its username, so renaming it would change the login);
 *   - detached rows (`federationHomeOrphaned = 1`): the home domain now belongs
 *     to another incarnation, which never names an established account.
 */
export function isIdNamedStub(user: UserRow): boolean {
  if (!user.homeInstance || !user.homeUserId) return false;
  if (user.passwordHash !== REPLICATED_PASSWORD_HASH) return false;
  if (user.federationHomeOrphaned === 1) return false;
  return user.username === `${user.homeUserId}@${user.homeInstance}`.toLowerCase();
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
 * Rename an id-named stub (`isIdNamedStub`) to `<username>@<domain>`, where
 * `username` is the handle the row's home reports. Home usernames never change,
 * so this happens at most once per row. Every other row is returned unchanged.
 *
 * Collision-safe: when another row already holds the target name, the stub
 * keeps its id name (the next trusted username retries). With a `seed`, an
 * empty `displayName` is filled with `seed.displayName ?? username` and a
 * differing `status` is taken over.
 *
 * After a rename, every local user who can see the row (friends, DM partners,
 * shared space members; `collectProfileBroadcastTargetIds`) gets `user_updated`,
 * as `processProfileUpdateEvent` does, so open clients show the new name
 * without a reload.
 */
export function renameIdNamedStub(
  user: UserRow,
  username: string | null | undefined,
  db: ReturnType<typeof getDb>,
  seed?: StubRenameSeed,
): UserRow {
  if (!isIdNamedStub(user)) return user;
  const handle = username?.trim();
  if (!handle || handle.includes('@')) return user;

  const newUsername = `${handle}@${user.homeInstance}`.toLowerCase();
  if (newUsername === user.username) return user;

  const holder = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, newUsername))
    .get();
  if (holder && holder.id !== user.id) {
    console.warn(`[federation] Not renaming stub ${user.id} (${user.username}): ${newUsername} belongs to user ${holder.id}`);
    return user;
  }

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

  const renamed: UserRow = { ...user, ...updates };
  const userUpdatedEvent = { type: 'user_updated' as const, user: sanitizeUser(renamed, false) };
  for (const uid of collectProfileBroadcastTargetIds(user.id)) {
    connectionManager.sendToUser(uid, userUpdatedEvent);
  }
  return renamed;
}
