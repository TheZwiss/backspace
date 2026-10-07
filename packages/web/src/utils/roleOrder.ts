import type { Role } from '@backspace/shared';
import { canManageRoleAt, type HierarchyStanding } from '@backspace/shared/src/permissions';

// The order of a space's roles is its role hierarchy (docs/systems/permissions.md,
// "Role hierarchy", "Setting the order"). These are the pure rules the Roles
// list in Space Settings reorders by; the server applies the same comparison
// (`canManageRoleAt`) to `PATCH /api/spaces/:id/roles/:roleId` moves and
// renumbers the roles the same way (`moveRoleToPosition`).
//
// "Rank order" is most senior first, @everyone left out: @everyone is always
// at position 0, below every other role, and never moves.

/** The roles of `spaceId` in rank order: highest position first, @everyone (id === spaceId) left out. */
export function rolesInRankOrder(roles: readonly Role[], spaceId: string): Role[] {
  return roles.filter((r) => r.id !== spaceId).sort((a, b) => b.position - a.position);
}

/**
 * Whether the roles can be reordered at all: every role has its own position
 * from 1 up. An instance from before the role hierarchy stores every role at 0
 * and writes a position as given, so a move against it would not do what the
 * list shows; the list then offers no reorder controls.
 */
export function canReorderRoles(ranked: readonly Role[]): boolean {
  const seen = new Set<number>();
  for (const role of ranked) {
    if (role.position < 1 || seen.has(role.position)) return false;
    seen.add(role.position);
  }
  return true;
}

/**
 * Whether `viewer` may move the role at `fromIndex` of `ranked` (rank order)
 * to `toIndex`: the role and the position it moves to must both be below the
 * viewer's top role, unless the viewer owns the space or administers the
 * instance. A null `viewer` (their member row is not loaded) answers true and
 * leaves the decision to the server, like `viewerCanManageRoleAt`.
 */
export function canMoveRole(
  viewer: HierarchyStanding | null,
  ranked: readonly Role[],
  fromIndex: number,
  toIndex: number,
): boolean {
  if (fromIndex === toIndex) return false;
  const role = ranked[fromIndex];
  const slot = ranked[toIndex];
  if (!role || !slot) return false;
  if (!viewer) return true;
  return canManageRoleAt(viewer, role.position) && canManageRoleAt(viewer, slot.position);
}

/**
 * `ranked` with the role at `fromIndex` moved to `toIndex` and every position
 * renumbered n..1 (most senior first), the order the server stores after the
 * move. What to send for the move is `roleMoveRequest`.
 * Returns a new array of new role objects; `ranked` is left as it is.
 */
export function moveRoleInRankOrder(ranked: readonly Role[], fromIndex: number, toIndex: number): Role[] {
  const next = [...ranked];
  const [moving] = next.splice(fromIndex, 1);
  if (!moving) return ranked.map((r) => ({ ...r }));
  next.splice(toIndex, 0, moving);
  return next.map((r, index) => ({ ...r, position: next.length - index }));
}

/** The body of `PATCH /roles/:rid` that moves a role: next to an anchor role, plus `position` for older servers. */
export type RoleMoveRequest = { position: number; above: string } | { position: number; below: string };

/**
 * What to send to move the role at `fromIndex` of `ranked` (rank order) to
 * `toIndex`: the role the user sees in that place now is the anchor, and the
 * moved role goes directly above it when it moves up, directly below it when
 * it moves down. The server places it next to the anchor in the order it
 * holds, so the move does what the list showed even when the list is out of
 * date (a refresh that answered before the last move, another member's
 * move). `position` is the anchor's position, which is all a 1.7.x server
 * reads; a server that reads the anchor ignores it. Null when there is no
 * move.
 */
export function roleMoveRequest(ranked: readonly Role[], fromIndex: number, toIndex: number): RoleMoveRequest | null {
  const slot = ranked[toIndex];
  if (fromIndex === toIndex || !ranked[fromIndex] || !slot) return null;
  return toIndex < fromIndex
    ? { position: slot.position, above: slot.id }
    : { position: slot.position, below: slot.id };
}

/**
 * `roles` with the role a successful `PATCH /roles/:rid` answered put in
 * place of its old copy, so an editor shows what was saved at once; the
 * `space_access_changed` refresh that follows brings the rest of the space.
 * Only the role's own fields change here: a move renumbers other roles too,
 * which is `moveRoleInRankOrder`'s job, so `position` is kept.
 */
export function withSavedRole(roles: readonly Role[], saved: Role): Role[] {
  return roles.map((r) => (r.id === saved.id
    ? { ...r, name: saved.name, color: saved.color ?? r.color, permissions: saved.permissions ?? r.permissions }
    : r));
}
