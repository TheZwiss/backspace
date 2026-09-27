import { useMemo } from 'react';
import type { MemberWithUser, Role } from '@backspace/shared';
import { useSpaceStore } from '../stores/spaceStore';
import type { ProfileMemberContext } from '../stores/uiStore';

/**
 * The space member a profile was opened for, read from the loaded space.
 *
 * `member.userId` is the id on the space's own instance, which is also the id
 * the loaded member list carries, so the match is exact for local and
 * federated members alike. The member list only ever holds the current space,
 * so a context naming any other space resolves to nothing rather than to a
 * look-alike from the wrong space.
 */
export function useProfileMember(member: ProfileMemberContext | null | undefined): MemberWithUser | undefined {
  return useSpaceStore((s) =>
    member && s.currentSpaceId === member.spaceId
      ? s.members.find((m) => m.userId === member.userId)
      : undefined,
  );
}

/**
 * Non-reactive read of the same member and the origin of the space it belongs
 * to, for code that runs once when a profile opens.
 */
export function getProfileMember(
  member: ProfileMemberContext,
): { row: MemberWithUser; origin: string } | undefined {
  const state = useSpaceStore.getState();
  if (state.currentSpaceId !== member.spaceId) return undefined;
  const row = state.members.find((m) => m.userId === member.userId);
  if (!row) return undefined;
  const origin = state.spaces.find((sp) => sp.id === member.spaceId)?._instanceOrigin ?? '';
  return { row, origin };
}

/**
 * The roles a profile shows for a space member: every assigned role except
 * @everyone (whose id is the space id), highest position first. Presence plays
 * no part; the roles are the member's whether they are connected or not.
 */
export function useProfileMemberRoles(member: ProfileMemberContext | null | undefined): Role[] {
  const row = useProfileMember(member);
  return useMemo(
    () => (row?.roles ?? [])
      .filter((r) => r.id !== row?.spaceId)
      .sort((a, b) => b.position - a.position),
    [row],
  );
}
