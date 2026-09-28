// ─── Bitwise Permission Engine ──────────────────────────────────────────────
// Single source of truth for all permission bits. Used by both server and client.
// SQLite stores as TEXT (decimal string). Never put raw bigint into JSON.

export const PermissionBits = {
  ADMINISTRATOR:        1n << 0n,
  VIEW_CHANNEL:         1n << 1n,
  MANAGE_CHANNELS:      1n << 2n,
  MANAGE_ROLES:         1n << 3n,
  MANAGE_SPACE:         1n << 4n,
  CREATE_INVITE:        1n << 5n,
  KICK_MEMBERS:         1n << 6n,
  BAN_MEMBERS:          1n << 7n,
  SEND_MESSAGES:        1n << 10n,
  MANAGE_MESSAGES:      1n << 11n,
  ATTACH_FILES:         1n << 12n,
  READ_MESSAGE_HISTORY: 1n << 13n,
  ADD_REACTIONS:        1n << 14n,
  CONNECT:              1n << 20n,
  SPEAK:                1n << 21n,
  MUTE_MEMBERS:         1n << 22n,
  DEAFEN_MEMBERS:       1n << 23n,
  MOVE_MEMBERS:         1n << 24n,
  STREAM:               1n << 25n,
  DISCONNECT_MEMBERS:   1n << 26n,
} as const;

export type PermissionBit = (typeof PermissionBits)[keyof typeof PermissionBits];

export const ALL_PERMISSIONS = Object.values(PermissionBits).reduce((a, b) => a | b, 0n);

export const DEFAULT_EVERYONE_PERMISSIONS =
  PermissionBits.VIEW_CHANNEL |
  PermissionBits.SEND_MESSAGES |
  PermissionBits.CREATE_INVITE |
  PermissionBits.CONNECT |
  PermissionBits.SPEAK |
  PermissionBits.ATTACH_FILES |
  PermissionBits.READ_MESSAGE_HISTORY |
  PermissionBits.ADD_REACTIONS |
  PermissionBits.STREAM;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Check if a permissions value has a specific bit set. Accepts bigint or decimal string. */
export function hasPermissionBit(perms: bigint | string | undefined | null, bit: bigint): boolean {
  if (perms === undefined || perms === null) return false;
  const p = typeof perms === 'string' ? BigInt(perms) : perms;
  // ADMINISTRATOR grants everything
  if ((p & PermissionBits.ADMINISTRATOR) !== 0n) return true;
  return (p & bit) === bit;
}

/** Convert a bigint to a decimal string safe for JSON serialization. */
export function permissionsToString(perms: bigint): string {
  return perms.toString();
}

/** Convert a decimal string back to bigint. Returns 0n for falsy/invalid input. */
export function stringToPermissions(str: string | undefined | null): bigint {
  if (!str) return 0n;
  try {
    return BigInt(str);
  } catch {
    // Fallback: legacy JSON array format (e.g. '["VIEW_CHANNEL","SEND_MESSAGES"]')
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        let result = 0n;
        for (const key of parsed) {
          const bit = PermissionBits[key as keyof typeof PermissionBits];
          if (bit !== undefined) result |= bit;
        }
        return result;
      }
    } catch { /* not JSON either */ }
    return 0n;
  }
}

// ─── Role Hierarchy ─────────────────────────────────────────────────────────
// A role's `position` ranks it: higher is more senior. @everyone (id = space
// id) sits at 0 and every other role at 1 or above, each at its own position.
// A member's rank is the highest position among their roles, 0 with none.
// The same rule runs on the server (enforcement) and in the client (gating),
// so both sides read it from here. See docs/systems/permissions.md.

/** Where a member stands in a space's role hierarchy. */
export interface HierarchyStanding {
  /** Owns the space: above every role, and never a target. */
  isOwner: boolean;
  /** Administers the instance: acts like the owner, but may still be a target. */
  isInstanceAdmin: boolean;
  /** Highest position among the member's roles, @everyone excluded; 0 with none. */
  topPosition: number;
}

/** The highest position among `roles`, leaving out @everyone (id === spaceId). 0 when none remain. */
export function topRolePosition(roles: readonly { id: string; position: number }[], spaceId: string): number {
  let top = 0;
  for (const role of roles) {
    if (role.id !== spaceId && role.position > top) top = role.position;
  }
  return top;
}

/**
 * Whether `actor` may moderate `target` (kick, ban, voice mute/deafen, move,
 * disconnect, change their roles). Nobody acts on the owner; the owner and
 * instance admins act on everyone else; anyone else needs a strictly higher
 * top role than the target.
 */
export function canActOnMember(actor: HierarchyStanding, target: HierarchyStanding): boolean {
  if (target.isOwner) return false;
  if (actor.isOwner || actor.isInstanceAdmin) return true;
  return actor.topPosition > target.topPosition;
}

/**
 * Whether `actor` may create, edit, delete, assign, unassign or move a role
 * at `rolePosition` (or move one to it): only below their own top role,
 * unless they own the space or administer the instance.
 */
export function canManageRoleAt(actor: HierarchyStanding, rolePosition: number): boolean {
  if (actor.isOwner || actor.isInstanceAdmin) return true;
  return rolePosition < actor.topPosition;
}

// ─── Held-Bits Rule ─────────────────────────────────────────────────────────
// A member can only switch permission bits they hold in the space themselves,
// on a role and on a channel or category override. `held` is the actor's
// space-level permissions: the owner, instance admins and ADMINISTRATOR
// holders hold every bit. The rule compares the value before and after the
// change, so an unheld bit someone more senior set stays where it is while
// the actor edits the others, but the actor cannot switch it in either
// direction. It runs after the role hierarchy, which decides which roles the
// actor may edit at all. See docs/systems/permissions.md, "Held-bits rule".

/** The ErrorCode a held-bits refusal answers with. */
export type HeldBitsRefusal =
  | 'cannot_grant_unowned_permissions'
  | 'cannot_deny_unowned_permissions'
  | 'cannot_change_unowned_permissions';

/** The allow and deny bits of a channel or category override. */
export interface OverrideBits {
  allow: bigint;
  deny: bigint;
}

/**
 * The bits an actor holding `held` may not switch. Holding every permission
 * (owner, instance admin, ADMINISTRATOR) leaves nothing unheld, bits no
 * permission defines included, so a stray bit in an old row never blocks
 * them; anyone else may not switch a bit they do not hold.
 */
function unheldBits(held: bigint): bigint {
  return (held & ALL_PERMISSIONS) === ALL_PERMISSIONS ? 0n : ~held;
}

/**
 * Why a role's permissions may not go from `before` to `after` for an actor
 * holding `held`, or null when they may: switching on an unheld bit is a
 * grant, switching one off is a change.
 */
export function roleBitsChangeRefusal(held: bigint, before: bigint, after: bigint): HeldBitsRefusal | null {
  const unheld = unheldBits(held);
  if ((after & ~before & unheld) !== 0n) return 'cannot_grant_unowned_permissions';
  if ((before & ~after & unheld) !== 0n) return 'cannot_change_unowned_permissions';
  return null;
}

/**
 * Why an override may not go from `before` to `after` for an actor holding
 * `held`, or null when it may. A missing override (`null`) has no bits, so
 * `after` null is a delete. A newly allowed unheld bit is a grant, a newly
 * denied one a deny, and clearing one from allow or deny a change.
 */
export function overrideChangeRefusal(
  held: bigint,
  before: OverrideBits | null,
  after: OverrideBits | null,
): HeldBitsRefusal | null {
  const oldAllow = before?.allow ?? 0n;
  const oldDeny = before?.deny ?? 0n;
  const newAllow = after?.allow ?? 0n;
  const newDeny = after?.deny ?? 0n;
  const unheld = unheldBits(held);
  if ((newAllow & ~oldAllow & unheld) !== 0n) return 'cannot_grant_unowned_permissions';
  if ((newDeny & ~oldDeny & unheld) !== 0n) return 'cannot_deny_unowned_permissions';
  if ((((oldAllow & ~newAllow) | (oldDeny & ~newDeny)) & unheld) !== 0n) return 'cannot_change_unowned_permissions';
  return null;
}
