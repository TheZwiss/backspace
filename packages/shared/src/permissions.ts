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
  USE_VOICE_ACTIVITY:   1n << 25n,
  STREAM:               1n << 26n,
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
  PermissionBits.STREAM |
  PermissionBits.USE_VOICE_ACTIVITY;

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
    return 0n;
  }
}
