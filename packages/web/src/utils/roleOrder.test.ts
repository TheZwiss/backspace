import { describe, it, expect } from 'vitest';
import type { Role } from '@backspace/shared';
import type { HierarchyStanding } from '@backspace/shared/src/permissions';
import { rolesInRankOrder, canReorderRoles, canMoveRole, moveRoleInRankOrder, roleMoveRequest } from './roleOrder';

// The move rule for Space Settings > Roles (permissions.md, "Role hierarchy",
// "Setting the order"): a role moves only when it and the slot it moves to are
// both below the viewer's top role; the owner and instance admins move any
// role; @everyone never moves.

const SPACE_ID = 'space-1';

function role(id: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name: id, color: '#c4b5fd', position, permissions: '0', createdAt: 1 };
}

const EVERYONE = role(SPACE_ID, 0);
const ADMINS = role('admins', 5);
const MODS = role('mods', 4);
const HELPERS = role('helpers', 3);
const REGULARS = role('regulars', 2);
const GUESTS = role('guests', 1);

// Store order is not rank order: the rule must not depend on it.
const ROLES = [HELPERS, EVERYONE, GUESTS, ADMINS, REGULARS, MODS];

function standing(topPosition: number, extra: Partial<HierarchyStanding> = {}): HierarchyStanding {
  return { isOwner: false, isInstanceAdmin: false, topPosition, ...extra };
}

const OWNER = standing(0, { isOwner: true });
const INSTANCE_ADMIN = standing(0, { isInstanceAdmin: true });
const MODERATOR = standing(MODS.position);

const ranked = rolesInRankOrder(ROLES, SPACE_ID);
const indexOf = (id: string) => ranked.findIndex((r) => r.id === id);

describe('rolesInRankOrder', () => {
  it('lists the roles most senior first and leaves out @everyone', () => {
    expect(ranked.map((r) => r.id)).toEqual(['admins', 'mods', 'helpers', 'regulars', 'guests']);
  });
});

describe('canReorderRoles', () => {
  it('holds when every role has its own position from 1 up', () => {
    expect(canReorderRoles(ranked)).toBe(true);
  });

  it('refuses the tied positions of an instance that does not keep positions distinct', () => {
    // A server from before the role hierarchy stores every role at 0 and
    // applies a position as given, so a move there would do nothing useful.
    expect(canReorderRoles([role('a', 0), role('b', 0)])).toBe(false);
    expect(canReorderRoles([role('a', 2), role('b', 2), role('c', 1)])).toBe(false);
  });
});

describe('canMoveRole', () => {
  it('lets a moderator move a role below their own among the roles below their own', () => {
    expect(canMoveRole(MODERATOR, ranked, indexOf('guests'), indexOf('helpers'))).toBe(true);
    expect(canMoveRole(MODERATOR, ranked, indexOf('helpers'), indexOf('guests'))).toBe(true);
    expect(canMoveRole(MODERATOR, ranked, indexOf('regulars'), indexOf('guests'))).toBe(true);
  });

  it('refuses a moderator moving a role to their own rank or above', () => {
    expect(canMoveRole(MODERATOR, ranked, indexOf('helpers'), indexOf('mods'))).toBe(false);
    expect(canMoveRole(MODERATOR, ranked, indexOf('guests'), indexOf('admins'))).toBe(false);
  });

  it('refuses a moderator moving their own role or one above it', () => {
    expect(canMoveRole(MODERATOR, ranked, indexOf('mods'), indexOf('helpers'))).toBe(false);
    expect(canMoveRole(MODERATOR, ranked, indexOf('admins'), indexOf('guests'))).toBe(false);
  });

  it('refuses a member with no role above @everyone any move', () => {
    const plain = standing(0);
    expect(canMoveRole(plain, ranked, indexOf('guests'), indexOf('regulars'))).toBe(false);
  });

  it('lets the owner and instance admins move any role anywhere', () => {
    for (const viewer of [OWNER, INSTANCE_ADMIN]) {
      expect(canMoveRole(viewer, ranked, indexOf('guests'), indexOf('admins'))).toBe(true);
      expect(canMoveRole(viewer, ranked, indexOf('admins'), indexOf('guests'))).toBe(true);
    }
  });

  it('refuses a move to the same slot or outside the list', () => {
    expect(canMoveRole(OWNER, ranked, indexOf('mods'), indexOf('mods'))).toBe(false);
    expect(canMoveRole(OWNER, ranked, indexOf('guests'), ranked.length)).toBe(false);
    expect(canMoveRole(OWNER, ranked, 0, -1)).toBe(false);
  });

  it('leaves the move to the server when the viewer is not known', () => {
    expect(canMoveRole(null, ranked, indexOf('guests'), indexOf('admins'))).toBe(true);
  });
});

describe('moveRoleInRankOrder', () => {
  it('moves the role and renumbers every position n..1, as the server does', () => {
    const moved = moveRoleInRankOrder(ranked, indexOf('guests'), indexOf('mods'));
    expect(moved.map((r) => [r.id, r.position])).toEqual([
      ['admins', 5], ['guests', 4], ['mods', 3], ['helpers', 2], ['regulars', 1],
    ]);
  });

  it('moves a role down', () => {
    const moved = moveRoleInRankOrder(ranked, indexOf('admins'), indexOf('regulars'));
    expect(moved.map((r) => r.id)).toEqual(['mods', 'helpers', 'regulars', 'admins', 'guests']);
    expect(moved.map((r) => r.position)).toEqual([5, 4, 3, 2, 1]);
  });

  it('does not change the list it was given', () => {
    moveRoleInRankOrder(ranked, 0, 4);
    expect(ranked.map((r) => r.id)).toEqual(['admins', 'mods', 'helpers', 'regulars', 'guests']);
    expect(ranked[0]?.position).toBe(5);
  });
});

describe('roleMoveRequest', () => {
  it('moves a role up to directly above the role shown in that place', () => {
    expect(roleMoveRequest(ranked, indexOf('guests'), indexOf('mods'))).toEqual({ position: 4, above: 'mods' });
  });

  it('moves a role down to directly below the role shown in that place', () => {
    expect(roleMoveRequest(ranked, indexOf('admins'), indexOf('regulars'))).toEqual({ position: 2, below: 'regulars' });
  });

  it('lands where moveRoleInRankOrder shows it', () => {
    for (const [from, to] of [[0, 4], [4, 0], [1, 2], [3, 1]] as const) {
      const request = roleMoveRequest(ranked, from, to)!;
      const shown = moveRoleInRankOrder(ranked, from, to).map((r) => r.id);
      const moved = ranked[from]!.id;
      const anchor = 'above' in request ? request.above : request.below;
      const offset = 'above' in request ? -1 : 1;
      expect(shown[shown.indexOf(anchor) + offset]).toBe(moved);
      expect(shown.length - shown.indexOf(moved)).toBe(request.position);
    }
  });

  it('is null when there is no move', () => {
    expect(roleMoveRequest(ranked, 2, 2)).toBeNull();
    expect(roleMoveRequest(ranked, 0, 9)).toBeNull();
  });
});
