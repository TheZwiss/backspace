import type Database from 'better-sqlite3';

// Role positions (docs/systems/permissions.md, "Role hierarchy"). Raw
// better-sqlite3 so the same code runs at boot, before the Drizzle handle is
// shared, and inside the role routes through getRawDb().

interface RoleOrderRow {
  id: string;
  spaceId: string;
  position: number | null;
}

/**
 * The non-@everyone roles of one space, most senior first. Ties (every role
 * created before positions were maintained sits at 0) break by creation order,
 * oldest first, which is the order the role list and the member list have
 * always shown them in.
 */
function orderedRoles(db: Database.Database, spaceId: string): RoleOrderRow[] {
  return db.prepare(
    `SELECT id, space_id AS spaceId, position FROM roles
     WHERE space_id = ? AND id != space_id
     ORDER BY position DESC, created_at ASC, rowid ASC`,
  ).all(spaceId) as RoleOrderRow[];
}

/** Write `ordered` (most senior first) back as positions n..1. Only changed rows are written. */
function writeOrder(db: Database.Database, spaceId: string, ordered: RoleOrderRow[]): void {
  const update = db.prepare('UPDATE roles SET position = ? WHERE id = ? AND space_id = ?');
  ordered.forEach((role, index) => {
    const position = ordered.length - index;
    if (role.position !== position) update.run(position, role.id, spaceId);
  });
  db.prepare('UPDATE roles SET position = 0 WHERE id = ? AND space_id = ? AND position IS NOT 0').run(spaceId, spaceId);
}

/**
 * Give every role of `spaceId` its own position: @everyone 0, the others
 * n..1 in their current order. A role inserted at position 0 lands at the
 * bottom, just above @everyone. Idempotent.
 */
export function normalizeRolePositions(db: Database.Database, spaceId: string): void {
  db.transaction(() => writeOrder(db, spaceId, orderedRoles(db, spaceId)))();
}

/**
 * Move a role to `position` (1 = just above @everyone) and renumber the rest
 * so positions stay distinct. `position` is clamped to the roles that exist.
 */
export function moveRoleToPosition(db: Database.Database, spaceId: string, roleId: string, position: number): void {
  db.transaction(() => {
    const ordered = orderedRoles(db, spaceId);
    const from = ordered.findIndex((r) => r.id === roleId);
    if (from === -1) return;
    const [moving] = ordered.splice(from, 1);
    const clamped = Math.min(Math.max(position, 1), ordered.length + 1);
    // Most senior first: position p sits at index (count - p).
    ordered.splice(ordered.length + 1 - clamped, 0, moving!);
    writeOrder(db, spaceId, ordered);
  })();
}

/**
 * Boot-time pass over every space. Databases from before the hierarchy was
 * enforced have every role at position 0; this turns their displayed order
 * into distinct positions once, and is a no-op afterwards.
 */
export function normalizeAllRolePositions(db: Database.Database): void {
  const spaces = db.prepare('SELECT id FROM spaces').all() as { id: string }[];
  for (const { id } of spaces) normalizeRolePositions(db, id);
}
