import { eq, and, sql } from 'drizzle-orm';
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

  // Look up the channel to get its categoryId
  const channel = db.select().from(schema.channels).where(eq(schema.channels.id, channelId)).get();
  if (!channel) return base;

  // Fetch category overrides (if channel is in a category)
  let catOverrides: typeof schema.categoryOverrides.$inferSelect[] = [];
  if (channel.categoryId) {
    catOverrides = db.select().from(schema.categoryOverrides)
      .where(eq(schema.categoryOverrides.categoryId, channel.categoryId))
      .all();
  }

  // Fetch channel overrides
  const chanOverrides = db.select().from(schema.channelOverrides)
    .where(eq(schema.channelOverrides.channelId, channelId))
    .all();

  // If neither has overrides, return base
  if (catOverrides.length === 0 && chanOverrides.length === 0) return base;

  // ─── Interleaved Resolution ──────────────────────────────────────────
  // Within each tier (@everyone, roles, member), apply category first,
  // then channel. Channel bits win for any bit they explicitly set.

  // Tier 1: @everyone override (targetType='role', targetId=spaceId)
  const catEveryoneOverride = catOverrides.find(o => o.targetType === 'role' && o.targetId === spaceId);
  if (catEveryoneOverride) {
    const deny = stringToPermissions(catEveryoneOverride.deny);
    const allow = stringToPermissions(catEveryoneOverride.allow);
    base = (base & ~deny) | allow;
  }
  const chanEveryoneOverride = chanOverrides.find(o => o.targetType === 'role' && o.targetId === spaceId);
  if (chanEveryoneOverride) {
    const deny = stringToPermissions(chanEveryoneOverride.deny);
    const allow = stringToPermissions(chanEveryoneOverride.allow);
    base = (base & ~deny) | allow;
  }

  // Tier 2: Role overrides (combined for all assigned roles)
  let catCombinedAllow = 0n;
  let catCombinedDeny = 0n;
  for (const roleId of assignedRoleIds) {
    const roleOverride = catOverrides.find(o => o.targetType === 'role' && o.targetId === roleId);
    if (roleOverride) {
      catCombinedAllow |= stringToPermissions(roleOverride.allow);
      catCombinedDeny |= stringToPermissions(roleOverride.deny);
    }
  }
  base = (base & ~catCombinedDeny) | catCombinedAllow;

  let chanCombinedAllow = 0n;
  let chanCombinedDeny = 0n;
  for (const roleId of assignedRoleIds) {
    const roleOverride = chanOverrides.find(o => o.targetType === 'role' && o.targetId === roleId);
    if (roleOverride) {
      chanCombinedAllow |= stringToPermissions(roleOverride.allow);
      chanCombinedDeny |= stringToPermissions(roleOverride.deny);
    }
  }
  base = (base & ~chanCombinedDeny) | chanCombinedAllow;

  // Tier 3: Member-specific override
  const catMemberOverride = catOverrides.find(o => o.targetType === 'member' && o.targetId === userId);
  if (catMemberOverride) {
    const deny = stringToPermissions(catMemberOverride.deny);
    const allow = stringToPermissions(catMemberOverride.allow);
    base = (base & ~deny) | allow;
  }
  const chanMemberOverride = chanOverrides.find(o => o.targetType === 'member' && o.targetId === userId);
  if (chanMemberOverride) {
    const deny = stringToPermissions(chanMemberOverride.deny);
    const allow = stringToPermissions(chanMemberOverride.allow);
    base = (base & ~deny) | allow;
  }

  return base;
}

/**
 * Compute permissions at the category level (no channel step).
 * Used for determining if a category is "private" for a user.
 */
export function computeCategoryPermissions(userId: string, spaceId: string, categoryId: string): bigint {
  const db = getDb();

  const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, spaceId)).get();
  if (!space) return 0n;
  if (space.ownerId === userId) return ALL_PERMISSIONS;

  const userRow = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (userRow?.isAdmin === 1) return ALL_PERMISSIONS;

  const everyoneRole = db.select().from(schema.roles)
    .where(and(eq(schema.roles.id, spaceId), eq(schema.roles.spaceId, spaceId)))
    .get();
  let base = everyoneRole ? stringToPermissions(everyoneRole.permissions) : 0n;

  const memberRoleRows = db.select().from(schema.memberRoles)
    .where(and(eq(schema.memberRoles.spaceId, spaceId), eq(schema.memberRoles.userId, userId)))
    .all();
  const assignedRoleIds = memberRoleRows.map(mr => mr.roleId);

  for (const roleId of assignedRoleIds) {
    const role = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();
    if (role) base |= stringToPermissions(role.permissions);
  }

  if ((base & PermissionBits.ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;

  const catOverrides = db.select().from(schema.categoryOverrides)
    .where(eq(schema.categoryOverrides.categoryId, categoryId))
    .all();

  if (catOverrides.length === 0) return base;

  const everyoneOverride = catOverrides.find(o => o.targetType === 'role' && o.targetId === spaceId);
  if (everyoneOverride) {
    base = (base & ~stringToPermissions(everyoneOverride.deny)) | stringToPermissions(everyoneOverride.allow);
  }

  let combinedAllow = 0n;
  let combinedDeny = 0n;
  for (const roleId of assignedRoleIds) {
    const roleOverride = catOverrides.find(o => o.targetType === 'role' && o.targetId === roleId);
    if (roleOverride) {
      combinedAllow |= stringToPermissions(roleOverride.allow);
      combinedDeny |= stringToPermissions(roleOverride.deny);
    }
  }
  base = (base & ~combinedDeny) | combinedAllow;

  const memberOverride = catOverrides.find(o => o.targetType === 'member' && o.targetId === userId);
  if (memberOverride) {
    base = (base & ~stringToPermissions(memberOverride.deny)) | stringToPermissions(memberOverride.allow);
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

/**
 * True when a DM is a 1-on-1 (ownerId NULL) whose only other participant(s)
 * are tombstoned (isDeleted=1). Used to make a Deleted-User thread read-only:
 * no message create/edit/delete, so we never enqueue doomed/mis-directed relays.
 */
export function isDeadOneOnOne(dmChannelId: string, requesterId: string): boolean {
  const db = getDb();
  const channel = db.select({ ownerId: schema.dmChannels.ownerId })
    .from(schema.dmChannels).where(eq(schema.dmChannels.id, dmChannelId)).get();
  if (!channel || channel.ownerId !== null) return false; // groups are never a dead 1-on-1
  const others = db.select({ isDeleted: schema.users.isDeleted })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(and(
      eq(schema.dmMembers.dmChannelId, dmChannelId),
      sql`${schema.dmMembers.userId} != ${requesterId}`,
    ))
    .all();
  if (others.length === 0) return false;
  return others.every(o => o.isDeleted === 1);
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
