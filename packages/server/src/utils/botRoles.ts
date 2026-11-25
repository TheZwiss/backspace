import { and, eq, inArray } from 'drizzle-orm';
import { ALL_PERMISSIONS, parsePermissionString, permissionsToString, stringToPermissions } from '@backspace/shared/src/permissions.js';
import { getDb, getRawDb, schema } from '../db/index.js';
import { normalizeRolePositions } from '../db/rolePositions.js';
import { generateSnowflake } from './snowflake.js';

/**
 * A bot's managed role (bots.md, "Permissions on invite"): when a space
 * manager adds a bot, the permissions they grant out of the bot's requested
 * ones go into a role created for that bot alone (`roles.managed_bot_id`).
 * The role sits at the bottom of the hierarchy, can be edited and moved like
 * any other, is never given to anyone else nor deleted on its own, and goes
 * when the bot leaves the space. Permission checks do not know about it: the
 * bot holds its bits through an ordinary role.
 */

/** The colour a managed role starts with: the default role colour. */
const MANAGED_ROLE_COLOR = '#b9bbbe';

/**
 * A requested-permissions value from a request or a peer: a canonical decimal
 * string (`parsePermissionString`) naming defined bits only. Null otherwise.
 */
export function parseRequestedPermissions(value: unknown): bigint | null {
  const bits = parsePermissionString(value);
  if (bits === null || (bits & ~ALL_PERMISSIONS) !== 0n) return null;
  return bits;
}

/** The stored requested permissions as bits: none is 0n, undefined bits are dropped. */
export function storedRequestedPermissions(column: string | null | undefined): bigint {
  const bits = stringToPermissions(column);
  return bits < 0n ? 0n : bits & ALL_PERMISSIONS;
}

/** The name a bot's managed role is given: its display name, else its handle. */
export function managedRoleBaseName(bot: { displayName: string | null; username: string }): string {
  const display = bot.displayName?.trim();
  if (display) return display;
  return bot.username.split('@')[0] || bot.username;
}

/**
 * `base` when no other role of `spaceId` carries it (names are unique per
 * space, case-insensitively), else the first free of "base (2)", "base (3)"
 * and so on. `exceptRoleId` is a role whose own name does not count.
 */
function freeRoleName(spaceId: string, base: string, exceptRoleId: string | null): string {
  const taken = getRawDb().prepare(
    'SELECT 1 FROM roles WHERE space_id = ? AND name COLLATE NOCASE = ? AND id != ?',
  );
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} (${n})`;
    if (!taken.get(spaceId, name, exceptRoleId ?? '')) return name;
  }
}

/**
 * Create the managed role of a bot just added to `spaceId`, carrying
 * `permissions`, at the bottom of the hierarchy (just above @everyone), and
 * give it to the bot. The caller has checked the grant (requested bits, held
 * bits) and announces the change. Returns the role's id.
 */
export function createManagedBotRole(
  spaceId: string,
  bot: { id: string; displayName: string | null; username: string },
  permissions: bigint,
): string {
  const db = getDb();
  const roleId = generateSnowflake();
  const name = freeRoleName(spaceId, managedRoleBaseName(bot), null);
  db.transaction((tx) => {
    tx.insert(schema.roles).values({
      id: roleId,
      spaceId,
      name,
      color: MANAGED_ROLE_COLOR,
      // Position 0 ties with @everyone's slot only; normalising places the
      // newest role last, at 1, and moves the others up (as a new role).
      position: 0,
      permissions: permissionsToString(permissions),
      createdAt: Date.now(),
      managedBotId: bot.id,
    }).run();
    tx.insert(schema.memberRoles).values({ spaceId, userId: bot.id, roleId }).run();
  });
  normalizeRolePositions(getRawDb(), spaceId);
  return roleId;
}

/** Delete roles by id with the overrides that name them, then renumber each space's roles. */
function deleteRoles(roles: readonly { id: string; spaceId: string }[]): void {
  if (roles.length === 0) return;
  const ids = roles.map((r) => r.id);
  getDb().transaction((tx) => {
    // Overrides name their target without a foreign key, so they would outlive the role.
    tx.delete(schema.channelOverrides).where(and(
      eq(schema.channelOverrides.targetType, 'role'),
      inArray(schema.channelOverrides.targetId, ids),
    )).run();
    tx.delete(schema.categoryOverrides).where(and(
      eq(schema.categoryOverrides.targetType, 'role'),
      inArray(schema.categoryOverrides.targetId, ids),
    )).run();
    // member_roles rows go with the role (foreign key, cascade).
    tx.delete(schema.roles).where(inArray(schema.roles.id, ids)).run();
  });
  for (const spaceId of new Set(roles.map((r) => r.spaceId))) normalizeRolePositions(getRawDb(), spaceId);
}

/**
 * The bot left `spaceId` (removed, kicked, banned): its managed role there
 * goes, with the overrides that name it. True when it had one; the caller
 * announces the change.
 */
export function deleteManagedBotRole(spaceId: string, botId: string): boolean {
  const role = getDb().select({ id: schema.roles.id, spaceId: schema.roles.spaceId })
    .from(schema.roles)
    .where(and(eq(schema.roles.spaceId, spaceId), eq(schema.roles.managedBotId, botId)))
    .get();
  if (!role) return false;
  deleteRoles([role]);
  return true;
}

/**
 * The bot's account is gone: every managed role of it goes. Answers the
 * spaces that lost one, for the caller to announce.
 */
export function deleteAllManagedBotRoles(botId: string): string[] {
  const roles = getDb().select({ id: schema.roles.id, spaceId: schema.roles.spaceId })
    .from(schema.roles)
    .where(eq(schema.roles.managedBotId, botId))
    .all();
  deleteRoles(roles);
  return [...new Set(roles.map((r) => r.spaceId))];
}

/**
 * The bot was renamed: each of its managed roles takes the new name (or the
 * first free variant of it in that space), replacing whatever name a manager
 * gave it. Answers the spaces where a name changed, for the caller to announce.
 */
export function renameManagedBotRoles(bot: { id: string; displayName: string | null; username: string }): string[] {
  const db = getDb();
  const base = managedRoleBaseName(bot);
  const roles = db.select({ id: schema.roles.id, spaceId: schema.roles.spaceId, name: schema.roles.name })
    .from(schema.roles)
    .where(eq(schema.roles.managedBotId, bot.id))
    .all();
  const changed: string[] = [];
  for (const role of roles) {
    const name = freeRoleName(role.spaceId, base, role.id);
    if (name === role.name) continue;
    db.update(schema.roles).set({ name }).where(eq(schema.roles.id, role.id)).run();
    changed.push(role.spaceId);
  }
  return changed;
}
