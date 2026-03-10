import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import {
  PermissionBits,
  ALL_PERMISSIONS,
  stringToPermissions,
  permissionsToString,
} from '@backspace/shared/src/permissions.js';

// Re-export for convenience
export { PermissionBits, ALL_PERMISSIONS, permissionsToString, stringToPermissions };

// ─── Core Resolution Engine ─────────────────────────────────────────────────

/**
 * Compute the effective permissions for a user in a space, optionally scoped
 * to a specific channel. Follows Discord's resolution order:
 *
 * 1. Owner → ALL_PERMISSIONS
 * 2. Base = @everyone.permissions | union of all assigned role permissions
 * 3. ADMINISTRATOR in base → ALL_PERMISSIONS
 * 4. If channelId provided, apply channel overrides in order:
 *    a. @everyone role override
 *    b. Role overrides (combined)
 *    c. Member-specific override
 */
export function computePermissions(userId: string, spaceId: string, channelId?: string): bigint {
  const db = getDb();

  // 1. Owner check
  const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, spaceId)).get();
  if (!space) return 0n;
  if (space.ownerId === userId) return ALL_PERMISSIONS;

  // 1b. Instance admin — full access across all spaces
  const userRow = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (userRow?.isAdmin === 1) return ALL_PERMISSIONS;

  // 2. Base permissions from @everyone role (id === spaceId)
  const everyoneRole = db.select().from(schema.roles)
    .where(and(eq(schema.roles.id, spaceId), eq(schema.roles.spaceId, spaceId)))
    .get();
  let base = everyoneRole ? stringToPermissions(everyoneRole.permissions) : 0n;

  // Get user's assigned roles via member_roles
  const memberRoleRows = db.select().from(schema.memberRoles)
    .where(and(
      eq(schema.memberRoles.spaceId, spaceId),
      eq(schema.memberRoles.userId, userId),
    ))
    .all();

  const assignedRoleIds = memberRoleRows.map(mr => mr.roleId);

  if (assignedRoleIds.length > 0) {
    // Fetch all assigned roles and OR their permissions into base
    for (const roleId of assignedRoleIds) {
      const role = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();
      if (role) {
        base |= stringToPermissions(role.permissions);
      }
    }
  }

  // 3. Admin shortcut
  if ((base & PermissionBits.ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;

  // If no channel, return space-level perms
  if (!channelId) return base;

  // 4. Channel overrides
  const overrides = db.select().from(schema.channelOverrides)
    .where(eq(schema.channelOverrides.channelId, channelId))
    .all();

  if (overrides.length === 0) return base;

  // 4a. @everyone role override (target_type='role', target_id=spaceId)
  const everyoneOverride = overrides.find(o => o.targetType === 'role' && o.targetId === spaceId);
  if (everyoneOverride) {
    const deny = stringToPermissions(everyoneOverride.deny);
    const allow = stringToPermissions(everyoneOverride.allow);
    base = (base & ~deny) | allow;
  }

  // 4b. Role overrides (combined for all assigned roles)
  let combinedAllow = 0n;
  let combinedDeny = 0n;
  for (const roleId of assignedRoleIds) {
    const roleOverride = overrides.find(o => o.targetType === 'role' && o.targetId === roleId);
    if (roleOverride) {
      combinedAllow |= stringToPermissions(roleOverride.allow);
      combinedDeny |= stringToPermissions(roleOverride.deny);
    }
  }
  base = (base & ~combinedDeny) | combinedAllow;

  // 4c. Member-specific override
  const memberOverride = overrides.find(o => o.targetType === 'member' && o.targetId === userId);
  if (memberOverride) {
    const deny = stringToPermissions(memberOverride.deny);
    const allow = stringToPermissions(memberOverride.allow);
    base = (base & ~deny) | allow;
  }

  return base;
}

/**
 * Check if a user has a specific permission in a space/channel.
 */
export function hasPermission(
  userId: string,
  spaceId: string,
  permission: bigint,
  channelId?: string,
): boolean {
  const perms = computePermissions(userId, spaceId, channelId);
  // ADMINISTRATOR grants everything
  if ((perms & PermissionBits.ADMINISTRATOR) !== 0n) return true;
  return (perms & permission) === permission;
}

// ─── Existing helpers ───────────────────────────────────────────────────────

export function getMember(spaceId: string, userId: string) {
  const db = getDb();
  return db.select().from(schema.spaceMembers)
    .where(and(
      eq(schema.spaceMembers.spaceId, spaceId),
      eq(schema.spaceMembers.userId, userId),
    ))
    .get();
}

export function isMember(spaceId: string, userId: string): boolean {
  return getMember(spaceId, userId) !== undefined;
}

export function isSpaceOwner(spaceId: string, userId: string): boolean {
  const db = getDb();
  const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, spaceId)).get();
  return space?.ownerId === userId;
}

export function getChannelSpaceId(channelId: string): string | null {
  const db = getDb();
  const channel = db.select().from(schema.channels).where(eq(schema.channels.id, channelId)).get();
  return channel?.spaceId ?? null;
}

export function isDmMember(dmChannelId: string, userId: string): boolean {
  const db = getDb();
  const member = db.select().from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, dmChannelId),
      eq(schema.dmMembers.userId, userId),
    ))
    .get();
  return member !== undefined;
}

export function isBanned(spaceId: string, userId: string): boolean {
  const db = getDb();
  const ban = db.select().from(schema.bans)
    .where(and(
      eq(schema.bans.spaceId, spaceId),
      eq(schema.bans.userId, userId),
    ))
    .get();
  return ban !== undefined;
}
