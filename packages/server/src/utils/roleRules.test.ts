import { describe, it, expect } from 'vitest';
import {
  ALL_PERMISSIONS,
  PermissionBits,
  canActOnMember,
  canManageRoleAt,
  topRolePosition,
  roleBitsChangeRefusal,
  overrideChangeRefusal,
  type HierarchyStanding,
} from '@backspace/shared/src/permissions.js';

// The role rules in @backspace/shared (docs/systems/permissions.md, "Role
// hierarchy" and "Held-bits rule"). The server enforces them and the client
// gates with them, so they are tested once here, as pure functions.

const member = (topPosition: number): HierarchyStanding => ({ isOwner: false, isInstanceAdmin: false, topPosition });
const owner: HierarchyStanding = { isOwner: true, isInstanceAdmin: false, topPosition: 0 };
const instanceAdmin: HierarchyStanding = { isOwner: false, isInstanceAdmin: true, topPosition: 0 };

describe('topRolePosition', () => {
  it('is the highest position among the roles, leaving out @everyone', () => {
    expect(topRolePosition([{ id: 's', position: 0 }, { id: 'a', position: 2 }, { id: 'b', position: 5 }], 's')).toBe(5);
  });

  it('is 0 with no roles or only @everyone', () => {
    expect(topRolePosition([], 's')).toBe(0);
    expect(topRolePosition([{ id: 's', position: 7 }], 's')).toBe(0);
  });
});

describe('canActOnMember', () => {
  it('needs a strictly higher top role', () => {
    expect(canActOnMember(member(3), member(2))).toBe(true);
    expect(canActOnMember(member(2), member(2))).toBe(false);
    expect(canActOnMember(member(1), member(2))).toBe(false);
    expect(canActOnMember(member(1), member(0))).toBe(true);
  });

  it('lets nobody act on the owner, and the owner and instance admins act on everyone else', () => {
    expect(canActOnMember(instanceAdmin, owner)).toBe(false);
    expect(canActOnMember(owner, member(99))).toBe(true);
    expect(canActOnMember(instanceAdmin, member(99))).toBe(true);
    expect(canActOnMember(member(5), instanceAdmin)).toBe(true);
  });
});

describe('canManageRoleAt', () => {
  it('allows only roles strictly below the actor\'s top role', () => {
    expect(canManageRoleAt(member(3), 2)).toBe(true);
    expect(canManageRoleAt(member(3), 0)).toBe(true);
    expect(canManageRoleAt(member(3), 3)).toBe(false);
    expect(canManageRoleAt(member(0), 0)).toBe(false);
  });

  it('exempts the owner and instance admins', () => {
    expect(canManageRoleAt(owner, 50)).toBe(true);
    expect(canManageRoleAt(instanceAdmin, 50)).toBe(true);
  });
});

const HELD = PermissionBits.MANAGE_ROLES | PermissionBits.SEND_MESSAGES;
const UNHELD = PermissionBits.BAN_MEMBERS;
// A bit no PermissionBits entry defines, as a stray value in an old row could carry.
const UNUSED_BIT = 1n << 40n;

describe('roleBitsChangeRefusal', () => {
  it('refuses switching on an unheld bit as a grant', () => {
    expect(roleBitsChangeRefusal(HELD, 0n, UNHELD)).toBe('cannot_grant_unowned_permissions');
    expect(roleBitsChangeRefusal(HELD, 0n, PermissionBits.ADMINISTRATOR)).toBe('cannot_grant_unowned_permissions');
  });

  it('refuses switching off an unheld bit with the neutral change code', () => {
    expect(roleBitsChangeRefusal(HELD, UNHELD, 0n)).toBe('cannot_change_unowned_permissions');
  });

  it('allows switching held bits and leaving unheld bits as they are', () => {
    expect(roleBitsChangeRefusal(HELD, UNHELD, UNHELD | PermissionBits.SEND_MESSAGES)).toBeNull();
    expect(roleBitsChangeRefusal(HELD, UNHELD | PermissionBits.MANAGE_ROLES, UNHELD)).toBeNull();
  });

  it('lets a holder of every bit switch anything, bits no permission uses included', () => {
    expect(roleBitsChangeRefusal(ALL_PERMISSIONS, 0n, ALL_PERMISSIONS)).toBeNull();
    expect(roleBitsChangeRefusal(ALL_PERMISSIONS, ALL_PERMISSIONS, 0n)).toBeNull();
    expect(roleBitsChangeRefusal(ALL_PERMISSIONS, UNUSED_BIT, 0n)).toBeNull();
  });

  it('refuses anyone else a bit no permission uses', () => {
    expect(roleBitsChangeRefusal(HELD, 0n, UNUSED_BIT)).toBe('cannot_grant_unowned_permissions');
  });
});

describe('overrideChangeRefusal', () => {
  const none = { allow: 0n, deny: 0n };

  it('names a new allow a grant and a new deny a deny', () => {
    expect(overrideChangeRefusal(HELD, null, { allow: UNHELD, deny: 0n })).toBe('cannot_grant_unowned_permissions');
    expect(overrideChangeRefusal(HELD, null, { allow: 0n, deny: UNHELD })).toBe('cannot_deny_unowned_permissions');
    // Allow to deny sets the deny.
    expect(overrideChangeRefusal(HELD, { allow: UNHELD, deny: 0n }, { allow: 0n, deny: UNHELD })).toBe('cannot_deny_unowned_permissions');
  });

  it('names clearing an unheld allow or deny, and deleting the override, a change', () => {
    expect(overrideChangeRefusal(HELD, { allow: UNHELD, deny: 0n }, none)).toBe('cannot_change_unowned_permissions');
    expect(overrideChangeRefusal(HELD, { allow: 0n, deny: UNHELD }, none)).toBe('cannot_change_unowned_permissions');
    expect(overrideChangeRefusal(HELD, { allow: UNHELD, deny: 0n }, null)).toBe('cannot_change_unowned_permissions');
  });

  it('allows editing held bits while unheld bits stay where they are', () => {
    expect(overrideChangeRefusal(HELD, { allow: UNHELD, deny: 0n }, { allow: UNHELD, deny: PermissionBits.SEND_MESSAGES })).toBeNull();
    expect(overrideChangeRefusal(HELD, { allow: PermissionBits.SEND_MESSAGES, deny: 0n }, null)).toBeNull();
    expect(overrideChangeRefusal(HELD, null, null)).toBeNull();
  });

  it('lets a holder of every bit change anything, bits no permission uses included', () => {
    expect(overrideChangeRefusal(ALL_PERMISSIONS, { allow: UNHELD, deny: UNHELD }, null)).toBeNull();
    expect(overrideChangeRefusal(ALL_PERMISSIONS, { allow: UNUSED_BIT, deny: 0n }, null)).toBeNull();
  });
});
