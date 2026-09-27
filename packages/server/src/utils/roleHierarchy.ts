import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import {
  canActOnMember,
  canManageRoleAt,
  type HierarchyStanding,
} from '@backspace/shared/src/permissions.js';

// Server side of the role hierarchy (docs/systems/permissions.md, "Role
// hierarchy"). The rule itself lives in @backspace/shared so the client gates
// with the same comparison the routes enforce; this module only reads the
// facts it compares from the database.
//
// Every id here is a user id on THIS instance. A moderator whose home is
// another instance acts through their local replicated user (the id their
// session authenticates as), and targets are named by their local id too, so
// both sides of the comparison resolve against this instance's member rows.

/** Where `userId` stands in `spaceId`'s role hierarchy. */
export function getHierarchyStanding(spaceId: string, userId: string): HierarchyStanding {
  const db = getDb();
  const space = db.select({ ownerId: schema.spaces.ownerId })
    .from(schema.spaces).where(eq(schema.spaces.id, spaceId)).get();
  const user = db.select({ isAdmin: schema.users.isAdmin })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  const positions = db.select({ id: schema.roles.id, position: schema.roles.position })
    .from(schema.memberRoles)
    .innerJoin(schema.roles, eq(schema.memberRoles.roleId, schema.roles.id))
    .where(and(
      eq(schema.memberRoles.spaceId, spaceId),
      eq(schema.memberRoles.userId, userId),
      eq(schema.roles.spaceId, spaceId),
    ))
    .all();

  let topPosition = 0;
  for (const row of positions) {
    const position = row.position ?? 0;
    if (row.id !== spaceId && position > topPosition) topPosition = position;
  }

  return {
    isOwner: space?.ownerId === userId,
    isInstanceAdmin: user?.isAdmin === 1,
    topPosition,
  };
}

/** Whether `actorId` outranks `targetId` in `spaceId` (see `canActOnMember`). */
export function canActOnMemberInSpace(spaceId: string, actorId: string, targetId: string): boolean {
  return canActOnMember(getHierarchyStanding(spaceId, actorId), getHierarchyStanding(spaceId, targetId));
}

/** Whether `actorId` may manage a role at `rolePosition` in `spaceId` (see `canManageRoleAt`). */
export function canManageRoleInSpace(spaceId: string, actorId: string, rolePosition: number): boolean {
  return canManageRoleAt(getHierarchyStanding(spaceId, actorId), rolePosition);
}
