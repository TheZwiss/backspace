import type { MemberWithUser, Role } from '@backspace/shared';
import {
  canActOnMember,
  canManageRoleAt,
  topRolePosition,
  roleBitsChangeRefusal,
  overrideChangeRefusal,
  stringToPermissions,
  type HierarchyStanding,
  type OverrideBits,
} from '@backspace/shared/src/permissions';
import { useSpaceStore, getMyUserIdForOrigin, type TaggedSpace } from '../stores/spaceStore';
import { canReorderRoles, rolesInRankOrder } from './roleOrder';

// Client gating for the role hierarchy and the held-bits rule
// (docs/systems/permissions.md, "Role hierarchy" and "Held-bits rule"). The
// comparisons are the shared ones the server enforces; this module only finds
// the facts to compare in the loaded space. These names are a stable surface
// for every role and permission editor; keep them when adding one.
//
// Ids are ids on the space's own instance: the member list is loaded from
// there, and the viewer is found through getMyUserIdForOrigin, so a viewer
// whose home is another instance is compared as their replicated user there.
//
// When the facts are not loaded (the space is not the current one, or a
// member row is missing) the helpers answer true: the control stays offered
// and the server, which always has the facts, decides.

/** Where `member` stands in `space`'s role hierarchy. */
export function standingOf(space: Pick<TaggedSpace, 'id' | 'ownerId'>, member: MemberWithUser): HierarchyStanding {
  return {
    isOwner: space.ownerId === member.userId,
    isInstanceAdmin: member.user.isAdmin === true,
    topPosition: topRolePosition(member.roles ?? [], space.id),
  };
}

/** The viewer's user id on the instance `space` lives on. */
export function myUserIdInSpace(space: Pick<TaggedSpace, '_instanceOrigin'>): string | undefined {
  return getMyUserIdForOrigin(space._instanceOrigin ?? '');
}

/**
 * Whether the roles of `spaceId` rank anyone: every role but @everyone has its
 * own position from 1 up. An instance from before the role hierarchy keeps
 * every role at 0 and enforces no ranks, so there is nothing to compare. The
 * roles are the store's role list for the space together with the roles the
 * loaded members hold, so a tie shows even while the role list is not loaded.
 */
export function spaceRanksRoles(spaceId: string, members: readonly MemberWithUser[]): boolean {
  const byId = new Map<string, Role>();
  for (const role of useSpaceStore.getState().roles) {
    if (role.spaceId === spaceId) byId.set(role.id, role);
  }
  for (const member of members) {
    for (const role of member.roles ?? []) {
      if (role.spaceId === spaceId && !byId.has(role.id)) byId.set(role.id, role);
    }
  }
  return canReorderRoles(rolesInRankOrder([...byId.values()], spaceId));
}

/**
 * The viewer's standing in `space`, from its loaded member list; null (the
 * server decides) when the viewer's member row is not there, or when the
 * space's roles do not rank anyone (`spaceRanksRoles`).
 */
export function myStandingIn(
  space: Pick<TaggedSpace, 'id' | 'ownerId' | '_instanceOrigin'>,
  members: readonly MemberWithUser[],
): HierarchyStanding | null {
  if (!spaceRanksRoles(space.id, members)) return null;
  const myId = myUserIdInSpace(space);
  const me = myId ? members.find((m) => m.userId === myId) : undefined;
  return me ? standingOf(space, me) : null;
}

/**
 * Whether the viewer may moderate `target` in `space`: true for oneself and
 * whenever the viewer's standing is unknown (see the module comment).
 */
export function viewerCanActOn(
  space: Pick<TaggedSpace, 'id' | 'ownerId' | '_instanceOrigin'>,
  members: readonly MemberWithUser[],
  target: MemberWithUser,
): boolean {
  if (target.userId === myUserIdInSpace(space)) return true;
  const me = myStandingIn(space, members);
  if (!me) return true;
  return canActOnMember(me, standingOf(space, target));
}

/** Whether the viewer may manage a role at `rolePosition` in `space`: true when unknown. */
export function viewerCanManageRoleAt(
  space: Pick<TaggedSpace, 'id' | 'ownerId' | '_instanceOrigin'>,
  members: readonly MemberWithUser[],
  rolePosition: number,
): boolean {
  const me = myStandingIn(space, members);
  if (!me) return true;
  return canManageRoleAt(me, rolePosition);
}

/**
 * Imperative form for menus built at click time: may the viewer moderate the
 * member `targetUserId` (an id on the space's instance) of `spaceId`? Answers
 * from the store as it is now; true when that space is not the loaded one.
 */
export function viewerCanActOnUserInSpace(spaceId: string, targetUserId: string): boolean {
  const { spaces, members, currentSpaceId } = useSpaceStore.getState();
  if (currentSpaceId !== spaceId) return true;
  const space = spaces.find((s) => s.id === spaceId);
  const target = members.find((m) => m.userId === targetUserId);
  if (!space || !target) return true;
  return viewerCanActOn(space, members, target);
}

// ─── Held-bits rule ─────────────────────────────────────────────────────────

/**
 * The permission bits the viewer holds in `spaceId` at space level, or null
 * when they are not loaded. The value is the `myPermissions` the space's own
 * instance computed for the viewer's id there, so it is already per instance;
 * the owner, instance admins and ADMINISTRATOR holders get every bit.
 */
export function viewerHeldPermissions(
  spacePermissions: ReadonlyMap<string, string>,
  spaceId: string,
): bigint | null {
  const value = spacePermissions.get(spaceId);
  return value === undefined ? null : stringToPermissions(value);
}

/** Hook form of `viewerHeldPermissions` over the space store. */
export function useViewerHeldPermissions(spaceId: string): bigint | null {
  const value = useSpaceStore((s) => s.spacePermissions.get(spaceId));
  return value === undefined ? null : stringToPermissions(value);
}

/**
 * Whether the viewer may switch `bit` (on or off) on a role or an override:
 * they hold it, or `held` is unknown and the server decides.
 */
export function viewerCanSwitchBit(held: bigint | null, bit: bigint): boolean {
  if (held === null) return true;
  return roleBitsChangeRefusal(held, 0n, bit) === null;
}

/** The bits among `bits` the viewer may not switch; 0n when `held` is unknown. */
export function unswitchableBits(held: bigint | null, bits: readonly bigint[]): bigint {
  let locked = 0n;
  for (const bit of bits) {
    if (!viewerCanSwitchBit(held, bit)) locked |= bit;
  }
  return locked;
}

/**
 * Whether the viewer holds every bit in `permissions`, which is what giving a
 * member a role carrying them and deleting such a role need. True when
 * `held` is unknown.
 */
export function viewerHoldsEveryBit(held: bigint | null, permissions: bigint): boolean {
  if (held === null) return true;
  return roleBitsChangeRefusal(held, 0n, permissions) === null;
}

/**
 * Whether the viewer may create a role carrying `permissions` (a new role or
 * a copy): every bit on it must be one they hold. True when `held` is unknown.
 */
export function viewerCanCreateRoleWith(held: bigint | null, permissions: bigint): boolean {
  return viewerHoldsEveryBit(held, permissions);
}

/**
 * Whether the viewer may delete an override the server stores with `stored`
 * bits: deleting clears every bit it sets, so each must be one they hold.
 * True when `held` is unknown.
 */
export function viewerCanRemoveOverride(held: bigint | null, stored: OverrideBits): boolean {
  if (held === null) return true;
  return overrideChangeRefusal(held, stored, null) === null;
}
