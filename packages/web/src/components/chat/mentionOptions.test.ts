import { describe, expect, it } from 'vitest';
import type { MemberWithUser, Role } from '@backspace/shared';
import { mentionOptions } from './mentionOptions';
const roles = [{ id: 'default', name: '@everyone', isEveryone: true }, { id: 'team', name: 'Team', color: '#ff0000' }] as Role[];
const members = [{ userId: 'alice', user: { username: 'alice', displayName: 'Alice' } }] as MemberWithUser[];
describe('mention completion candidates', () => {
  it('never offers mass tokens without permission', () => {
    expect(mentionOptions({ query: '', members, roles, canMentionMass: false }).map(o => o.token)).toEqual(['<@alice>']);
  });
  it('includes everyone/here and nondefault roles when authorized', () => {
    expect(mentionOptions({ query: '', members, roles, canMentionMass: true }).map(o => o.token)).toEqual(['@everyone', '@here', '<@&team>', '<@alice>']);
    expect(mentionOptions({ query: 'TEAM', members, roles, canMentionMass: true })[0]).toMatchObject({ token: '<@&team>', label: '@Team' });
  });
  it('does not duplicate the @ prefix already present in a role name', () => {
    const prefixedRoles = [{ id: 'vip', name: '@VIP', isEveryone: false }] as Role[];
    expect(mentionOptions({ query: 'vip', members: [], roles: prefixedRoles, canMentionMass: true })[0]?.label).toBe('@VIP');
  });
  it('caps the same candidate list used for keyboard navigation', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...members[0], userId: String(i) })) as MemberWithUser[];
    expect(mentionOptions({ query: '', members: many, roles, canMentionMass: true })).toHaveLength(8);
  });
  it('supports ChannelUser candidates directly', () => {
    const candidates = [{ userId: 'bob', user: { username: 'bob', displayName: 'Bob' } as any, member: null, nameColor: null }];
    expect(mentionOptions({ query: 'bo', candidates, roles, canMentionMass: true }).map(o => o.token)).toEqual(['<@bob>']);
  });
});
