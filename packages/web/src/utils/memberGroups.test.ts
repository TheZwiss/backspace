import { describe, it, expect } from 'vitest';
import type { MemberWithUser, Role, User } from '@backspace/shared';
import { groupMembers, memberGroup, memberNameColor, memberTopRole, OWNER_NAME_COLOR } from './memberGroups';

function role(id: string, position: number, color: string): Role {
  return { id, spaceId: 's', name: id, color, position, permissions: '0', createdAt: 1 };
}
function member(userId: string, roles: Role[], status: User['status'] = 'online'): MemberWithUser {
  return {
    spaceId: 's', userId, nickname: null, joinedAt: 1, roles,
    user: {
      id: userId, username: userId, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
      bio: null, status, customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: [],
    },
  };
}

// The server lists a member's roles lowest first (#365: the owner's group
// used to take the first role above 0, which is the lowest).
const LOW = role('r-low', 1, '#a5f3c4');
const TOP = role('r-top', 3, '#c4b5fd');

describe('member colour and group', () => {
  it('takes the top role, whatever order the roles arrive in', () => {
    expect(memberTopRole(member('a', [LOW, TOP]))).toBe(TOP);
    expect(memberNameColor(member('a', [LOW, TOP]), 'owner')).toBe(TOP.color);
    expect(memberGroup(member('a', [LOW, TOP]), 'owner')).toMatchObject({ key: 'r-top', kind: 'role', position: 3 });
  });

  it('colours the owner by their top role, and rose without one', () => {
    expect(memberNameColor(member('owner', [LOW, TOP]), 'owner')).toBe(TOP.color);
    expect(memberNameColor(member('owner', []), 'owner')).toBe(OWNER_NAME_COLOR);
    expect(memberGroup(member('owner', [LOW, TOP]), 'owner').kind).toBe('owner');
  });

  it('leaves a member without a role uncoloured', () => {
    expect(memberNameColor(member('plain', []), 'owner')).toBeUndefined();
    expect(memberGroup(member('plain', []), 'owner').kind).toBe('online');
  });

  it('groups online members highest first and keeps offline members apart', () => {
    const { groups, offline } = groupMembers([
      member('plain', []), member('low', [LOW]), member('owner', [LOW]), member('top', [LOW, TOP]), member('away', [TOP], 'offline'),
    ], 'owner');
    expect(groups.map((g) => [g.key, g.members.map((m) => m.userId)])).toEqual([
      ['__owner__', ['owner']], ['r-top', ['top']], ['r-low', ['low']], ['__online__', ['plain']],
    ]);
    expect(offline.map((m) => m.userId)).toEqual(['away']);
  });
});
