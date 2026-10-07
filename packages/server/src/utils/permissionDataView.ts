import type { Role } from '@backspace/shared';
import { PermissionBits, hasPermissionBit } from '@backspace/shared/src/permissions.js';
import type { roles } from '../db/schema.js';

// What a client is told about a space's roles and permission overrides
// (docs/systems/permissions.md, "Who receives role and override data").
//
// Every member sees each role's display fields: name, colour, position. A
// role's permission bits, and the channel and category override rows, go only
// to a viewer who holds MANAGE_ROLES in the space (the owner, instance admins
// and ADMINISTRATOR holders included): those are the settings screens that
// read and write them. Every other member gets their own effective
// permissions already computed (`myPermissions` on the space and on each
// channel) and needs no role's bits to render anything.
//
// Every route and event that sends roles or overrides to a client shapes them
// here, so the rule lives in one place.

type RoleRow = typeof roles.$inferSelect;

/** Whether a viewer with these space-level permissions is sent role bits and override rows. */
export function viewerReadsPermissionData(viewerSpacePermissions: bigint): boolean {
  return hasPermissionBit(viewerSpacePermissions, PermissionBits.MANAGE_ROLES);
}

/**
 * One role as a client receives it. `withPermissions` is the answer of
 * `viewerReadsPermissionData` for the viewer; without it the role carries no
 * `permissions` field at all.
 */
export function roleView(row: RoleRow, withPermissions: boolean): Role {
  const role: Role = {
    id: row.id,
    spaceId: row.spaceId,
    name: row.name,
    color: row.color ?? '#b9bbbe',
    position: row.position ?? 0,
    isEveryone: row.id === row.spaceId,
    createdAt: row.createdAt,
  };
  if (withPermissions) role.permissions = row.permissions ?? '0';
  return role;
}

/** A space's role list for a viewer with these space-level permissions. */
export function rolesForViewer(rows: readonly RoleRow[], viewerSpacePermissions: bigint): Role[] {
  const withPermissions = viewerReadsPermissionData(viewerSpacePermissions);
  return rows.map(row => roleView(row, withPermissions));
}

/**
 * The roles listed on a member row. These name and colour the member (member
 * list groups, name colour, profile card) and rank them in the hierarchy, so
 * they carry display fields only, for every viewer. A manager reads the bits
 * from the space's role list.
 */
export function memberRolesView(rows: readonly RoleRow[], assignedRoleIds: ReadonlySet<string>): Role[] {
  return rows.filter(row => assignedRoleIds.has(row.id)).map(row => roleView(row, false));
}
