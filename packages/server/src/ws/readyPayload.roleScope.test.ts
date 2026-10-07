import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpaceWithChannelsAndMembers } from '@backspace/shared';
import { PermissionBits, stringToPermissions } from '@backspace/shared/src/permissions.js';
import { setWorkerId } from '../utils/snowflake.js';
import * as schema from '../db/schema.js';
import {
  storedBitsOf,
  SPACE_ID,
  PRIVATE_ID,
  GENERAL_ID,
  USERS,
  VIP_OVERRIDE_ALLOW,
  openFixtureDatabase,
  seedRolePayloadSpaces,
  type FixtureDb,
} from '../testing/rolePayloadFixture.js';

// The ready payload lists every role of each space the user belongs to. Each
// role's display fields go to every member; its permission bits only to
// members who hold MANAGE_ROLES there (permissions.md, "Who receives role and
// override data"). No override rows are in the payload for anyone: a member's
// own effective permissions arrive computed, as `myPermissions`.

setWorkerId(1);

let testDb: FixtureDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

beforeEach(() => {
  testDb = openFixtureDatabase().db;
  seedRolePayloadSpaces(testDb);
});

async function readySpace(userId: string): Promise<SpaceWithChannelsAndMembers> {
  const { buildReadyPayload } = await import('./handler.js');
  // The wire form: what JSON.stringify sends, so an undefined field is absent.
  const payload = JSON.parse(JSON.stringify(buildReadyPayload(userId))) as { spaces: SpaceWithChannelsAndMembers[] };
  const space = payload.spaces.find(s => s.id === SPACE_ID);
  if (!space) throw new Error('space missing from the ready payload');
  return space;
}

const DISPLAY = [
  { id: 'r-admin', name: 'Admins', color: '#ff0000', position: 4 },
  { id: 'r-mod', name: 'Mods', color: '#00ff00', position: 3 },
  { id: 'r-channels', name: 'Channel keepers', color: '#00ffff', position: 2 },
  { id: 'r-vip', name: 'VIP', color: '#0000ff', position: 1 },
  { id: SPACE_ID, name: '@everyone', color: '#b9bbbe', position: 0 },
];

function displayOf(space: SpaceWithChannelsAndMembers) {
  return [...space.roles]
    .sort((a, b) => b.position - a.position)
    .map(r => ({ id: r.id, name: r.name, color: r.color, position: r.position }));
}

describe('ready payload: roles by audience', () => {
  it('gives a plain member every role with its display fields and no bits', async () => {
    const space = await readySpace(USERS.member);
    expect(displayOf(space)).toEqual(DISPLAY);
    for (const role of space.roles) expect(role).not.toHaveProperty('permissions');
    expect(space.roles.find(r => r.id === SPACE_ID)?.isEveryone).toBe(true);
    expect(space.roles.find(r => r.id === 'r-vip')?.isEveryone).toBe(false);
  });

  it('gives a member whose role has overrides no bits, and their own permissions computed', async () => {
    const space = await readySpace(USERS.vip);
    for (const role of space.roles) expect(role).not.toHaveProperty('permissions');
    expect(space).not.toHaveProperty('overrides');

    const priv = space.channels.find(c => c.id === PRIVATE_ID);
    expect(priv).toBeDefined();
    for (const channel of space.channels) expect(channel).not.toHaveProperty('overrides');
    const bits = stringToPermissions(priv?.myPermissions);
    expect(bits & VIP_OVERRIDE_ALLOW).toBe(VIP_OVERRIDE_ALLOW);
    expect(stringToPermissions(space.myPermissions) & PermissionBits.ATTACH_FILES).toBe(PermissionBits.ATTACH_FILES);
  });

  it('gives a plain member no channel the override hides, and no bits for it', async () => {
    const space = await readySpace(USERS.member);
    expect(space.channels.map(c => c.id)).toEqual([GENERAL_ID]);
  });

  it('gives a MANAGE_CHANNELS holder no bits: the override and role editors need MANAGE_ROLES', async () => {
    const space = await readySpace(USERS.channelManager);
    for (const role of space.roles) expect(role).not.toHaveProperty('permissions');
  });

  it.each([
    ['a MANAGE_ROLES holder', USERS.manager],
    ['an ADMINISTRATOR holder', USERS.administrator],
    ['the owner', USERS.owner],
    ['an instance admin', USERS.instanceAdmin],
  ])('gives %s every role with its stored bits', async (_label, userId) => {
    const space = await readySpace(userId);
    expect(displayOf(space)).toEqual(DISPLAY);
    for (const role of space.roles) {
      expect(role.permissions).toBe(storedBitsOf(role.id));
    }
  });

  it('lists member roles with display fields only, for a manager too', async () => {
    for (const viewer of [USERS.member, USERS.manager, USERS.owner]) {
      const space = await readySpace(viewer);
      const vip = space.members.find(m => m.userId === USERS.vip);
      expect(vip?.roles.map(r => r.id)).toEqual(['r-vip']);
      for (const member of space.members) {
        for (const role of member.roles) expect(role).not.toHaveProperty('permissions');
      }
    }
  });

  it('shapes the bits on what the viewer holds now, so a role change takes effect at the next payload', async () => {
    expect((await readySpace(USERS.member)).roles.some(r => 'permissions' in r)).toBe(false);
    testDb.insert(schema.memberRoles).values({ spaceId: SPACE_ID, userId: USERS.member, roleId: 'r-mod' }).run();
    const after = await readySpace(USERS.member);
    expect(after.roles.every(r => r.permissions === storedBitsOf(r.id))).toBe(true);
  });
});
