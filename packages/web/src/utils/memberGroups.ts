import type { MemberWithUser, Role } from '@backspace/shared';

// How a space's member list groups and colours its members, in one place for
// every surface that shows them: the desktop member list, the phone members
// screen and the author name on a space message.
//
// A member's top role is their role with the highest position (their rank,
// docs/systems/permissions.md, "Role hierarchy"). Their name takes its colour;
// the owner without a role is rose; anyone else without a role has no colour
// of their own and the surface's text colour applies.

/** The colour of the owner's name when they hold no role. */
export const OWNER_NAME_COLOR = 'rgb(var(--accent-rose))';

/** The member's top role, or undefined without one. @everyone is never among a member's roles. */
export function memberTopRole(member: Pick<MemberWithUser, 'roles'>): Role | undefined {
  let top: Role | undefined;
  for (const role of member.roles ?? []) {
    if (!top || role.position > top.position) top = role;
  }
  return top;
}

/** The colour of the member's name, or undefined for the surface's own text colour. */
export function memberNameColor(member: Pick<MemberWithUser, 'userId' | 'roles'>, ownerId: string | undefined): string | undefined {
  const top = memberTopRole(member);
  if (top) return top.color;
  return ownerId !== undefined && member.userId === ownerId ? OWNER_NAME_COLOR : undefined;
}

/**
 * Which heading a member is listed under: the owner first, then one group per
 * top role, highest first, then everyone online without a role.
 */
export type MemberGroupKind = 'owner' | 'role' | 'online';

export interface MemberGroup {
  key: string;
  kind: MemberGroupKind;
  /** The role name for `kind: 'role'`; null for the translated headings. */
  label: string | null;
  /** Orders the groups: higher first. */
  position: number;
}

/** The group `member` is listed under. */
export function memberGroup(member: MemberWithUser, ownerId: string | undefined): MemberGroup {
  if (ownerId !== undefined && member.userId === ownerId) {
    return { key: '__owner__', kind: 'owner', label: null, position: Infinity };
  }
  const top = memberTopRole(member);
  if (top) return { key: top.id, kind: 'role', label: top.name.toUpperCase(), position: top.position };
  return { key: '__online__', kind: 'online', label: null, position: -1 };
}

/**
 * The online members grouped by `memberGroup`, groups highest first, and the
 * offline members as one list (roles do not group them).
 */
export function groupMembers(
  members: readonly MemberWithUser[],
  ownerId: string | undefined,
): { groups: (MemberGroup & { members: MemberWithUser[] })[]; offline: MemberWithUser[] } {
  const byKey = new Map<string, MemberGroup & { members: MemberWithUser[] }>();
  const offline: MemberWithUser[] = [];
  for (const member of members) {
    if (member.user.status === 'offline') {
      offline.push(member);
      continue;
    }
    const group = memberGroup(member, ownerId);
    const entry = byKey.get(group.key) ?? { ...group, members: [] };
    entry.members.push(member);
    byKey.set(group.key, entry);
  }
  return { groups: [...byKey.values()].sort((a, b) => b.position - a.position), offline };
}
