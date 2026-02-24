import { eq, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { MemberRole } from '@opencord/shared';
import {
  PermissionBits,
  ALL_PERMISSIONS,
  stringToPermissions,
  permissionsToString,
} from '@opencord/shared/src/permissions.js';

// Re-export for convenience
export { PermissionBits, ALL_PERMISSIONS, permissionsToString, stringToPermissions };

// ─── Core Resolution Engine ─────────────────────────────────────────────────

/**
 * Compute the effective permissions for a user in a server, optionally scoped
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
export function computePermissions(userId: string, serverId: string, channelId?: string): bigint {
  const db = getDb();

  // 1. Owner check
  const server = db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
  if (!server) return 0n;
  if (server.ownerId === userId) return ALL_PERMISSIONS;

  // 2. Base permissions from @everyone role (id === serverId)
  const everyoneRole = db.select().from(schema.roles)
    .where(and(eq(schema.roles.id, serverId), eq(schema.roles.serverId, serverId)))
    .get();
  let base = everyoneRole ? stringToPermissions(everyoneRole.permissions) : 0n;

  // Get user's assigned roles via member_roles
  const memberRoleRows = db.select().from(schema.memberRoles)
    .where(and(
      eq(schema.memberRoles.serverId, serverId),
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

  // If no channel, return server-level perms
  if (!channelId) return base;

  // 4. Channel overrides
  const overrides = db.select().from(schema.channelOverrides)
    .where(eq(schema.channelOverrides.channelId, channelId))
    .all();

  if (overrides.length === 0) return base;

  // 4a. @everyone role override (target_type='role', target_id=serverId)
  const everyoneOverride = overrides.find(o => o.targetType === 'role' && o.targetId === serverId);
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
 * Check if a user has a specific permission in a server/channel.
 */
export function hasPermission(
  userId: string,
  serverId: string,
  permission: bigint,
  channelId?: string,
): boolean {
  const perms = computePermissions(userId, serverId, channelId);
  // ADMINISTRATOR grants everything
  if ((perms & PermissionBits.ADMINISTRATOR) !== 0n) return true;
  return (perms & permission) === permission;
}

// ─── Existing helpers (kept for backward compat) ────────────────────────────

export function getMember(serverId: string, userId: string) {
  const db = getDb();
  return db.select().from(schema.serverMembers)
    .where(and(
      eq(schema.serverMembers.serverId, serverId),
      eq(schema.serverMembers.userId, userId),
    ))
    .get();
}

export function isMember(serverId: string, userId: string): boolean {
  return getMember(serverId, userId) !== undefined;
}

export function getMemberRole(serverId: string, userId: string): MemberRole | null {
  const member = getMember(serverId, userId);
  return member ? (member.role as MemberRole) : null;
}

export function isServerOwner(serverId: string, userId: string): boolean {
  const db = getDb();
  const server = db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
  return server?.ownerId === userId;
}

export function getChannelServerId(channelId: string): string | null {
  const db = getDb();
  const channel = db.select().from(schema.channels).where(eq(schema.channels.id, channelId)).get();
  return channel?.serverId ?? null;
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
