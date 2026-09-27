import type { MemberWithUser } from '@backspace/shared';
import {
  canActOnMember,
  canManageRoleAt,
  topRolePosition,
  type HierarchyStanding,
} from '@backspace/shared/src/permissions';
import { useSpaceStore, getMyUserIdForOrigin, type TaggedSpace } from '../stores/spaceStore';

// Client gating for the role hierarchy (docs/systems/permissions.md, "Role
// hierarchy"). The comparison is the shared one the server enforces; this
// module only finds the two members to compare in the loaded space.
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
 * The viewer's standing in `space`, from its loaded member list; null when
 * the viewer's member row is not there.
 */
export function myStandingIn(
  space: Pick<TaggedSpace, 'id' | 'ownerId' | '_instanceOrigin'>,
  members: readonly MemberWithUser[],
): HierarchyStanding | null {
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
