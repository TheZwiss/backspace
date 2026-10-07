import { PermissionBits, stringToPermissions } from './permissions';
import type { OverrideBits } from '@backspace/shared/src/permissions';

// Channel and category overrides as the client reads and edits them
// (docs/systems/permissions.md, "Resolution Algorithm", step 3). An override
// is one row per target; a control that switches one permission changes that
// bit of the row and nothing else.

/** An override row as the override routes list it. */
export interface StoredOverride {
  targetType: string;
  targetId: string;
  allow: string;
  deny: string;
}

/** Where a bit of an override stands: allowed, denied, or left to the tier above. */
export type OverrideBitState = 'allow' | 'deny' | 'neutral';

/** A stored row as bits, or null when there is none. */
export function overrideBitsOf(row: StoredOverride | undefined): OverrideBits | null {
  return row ? { allow: stringToPermissions(row.allow), deny: stringToPermissions(row.deny) } : null;
}

/**
 * `current` with `bits` put in `state`: allowed (and no longer denied),
 * denied (and no longer allowed) or neither. Every other bit is left as it
 * is. Null when the result sets nothing, which is the row removed.
 */
export function withOverrideBits(current: OverrideBits | null, bits: bigint, state: OverrideBitState): OverrideBits | null {
  let allow = (current?.allow ?? 0n) & ~bits;
  let deny = (current?.deny ?? 0n) & ~bits;
  if (state === 'allow') allow |= bits;
  if (state === 'deny') deny |= bits;
  return allow === 0n && deny === 0n ? null : { allow, deny };
}

/** The override of one target, found by type and id. */
export function findOverride(overrides: readonly StoredOverride[], targetType: string, targetId: string): StoredOverride | undefined {
  return overrides.find((o) => o.targetType === targetType && o.targetId === targetId);
}

/**
 * Whether these overrides hide their channel or category from everyone: the
 * @everyone override (the role whose id is the space id) denies View
 * Channels. This is what "private" means in channel and category settings.
 */
export function isHiddenFromEveryone(overrides: readonly StoredOverride[], spaceId: string): boolean {
  const everyone = overrideBitsOf(findOverride(overrides, 'role', spaceId));
  return everyone !== null && (everyone.deny & PermissionBits.VIEW_CHANNEL) !== 0n;
}
