import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { ExploreSpace, MemberWithUser, Role, SpaceWithChannelsAndMembers } from '@backspace/shared';
import { PermissionBits, permissionsToString, stringToPermissions } from '@backspace/shared/src/permissions.js';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import {
  CATEGORY_ID,
  EVERYONE_BITS,
  GENERAL_ID,
  PRIVATE_ID,
  REPLICATED,
  REQUEST_SPACE_ID,
  ROLE_BITS,
  addReplicatedMember,
  storedBitsOf,
  SPACE_ID,
  USERS,
  VIP_OVERRIDE_ALLOW,
  openFixtureDatabase,
  seedRolePayloadSpaces,
  type FixtureDb,
} from '../testing/rolePayloadFixture.js';

// Every HTTP route and event that sends a space's roles or its override rows
// to a client, by audience (permissions.md, "Who receives role and override
// data"): a non-member gets neither; a member gets each role's display fields;
// a member who holds MANAGE_ROLES also gets each role's bits and the override
// rows. Member rows list their roles with display fields only.

setWorkerId(1);

let sqlite: Database.Database;
let testDb: FixtureDb;
let currentUserId: string = USERS.owner;

const sendToUser = vi.fn();
const announceSpaceAccessChange = vi.fn();
const announceUserAccessChange = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/auth.js')>()),
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    addUserSpace: vi.fn(),
    sendToSpace: vi.fn(),
    sendToUser: (...args: unknown[]) => sendToUser(...args),
    announceSpaceAccessChange: (...args: unknown[]) => announceSpaceAccessChange(...args),
    announceUserAccessChange: (...args: unknown[]) => announceUserAccessChange(...args),
    getUserSpaceEntries: () => new Map<string, Set<string>>().entries(),
  },
}));

vi.mock('../ws/events.js', () => ({
  checkVoicePermissions: vi.fn(),
}));

let app: FastifyInstance;

beforeEach(async () => {
  const opened = openFixtureDatabase();
  sqlite = opened.sqlite;
  testDb = opened.db;
  seedRolePayloadSpaces(testDb);
  testDb.insert(schema.instanceSettings).values({ id: 1, updatedAt: Date.now() }).run();
  currentUserId = USERS.owner;
  sendToUser.mockReset();
  announceSpaceAccessChange.mockReset();
  announceUserAccessChange.mockReset();

  const { spaceRoutes } = await import('./spaces.js');
  const { channelRoutes } = await import('./channels.js');
  const { exploreRoutes } = await import('./explore.js');
  const { adminRoutes } = await import('./admin.js');
  app = Fastify();
  await app.register(spaceRoutes);
  await app.register(channelRoutes);
  await app.register(exploreRoutes);
  await app.register(adminRoutes);
});

function as(userId: string): void {
  currentUserId = userId;
}

async function getDetail(userId: string): Promise<{ status: number; body: SpaceWithChannelsAndMembers }> {
  as(userId);
  const res = await app.inject({ method: 'GET', url: `/api/spaces/${SPACE_ID}` });
  return { status: res.statusCode, body: res.json<SpaceWithChannelsAndMembers>() };
}

function expectNoBits(roles: readonly Role[]): void {
  expect(roles.length).toBeGreaterThan(0);
  for (const role of roles) expect(role).not.toHaveProperty('permissions');
}

function expectStoredBits(roles: readonly Role[]): void {
  expect(roles.length).toBeGreaterThan(0);
  for (const role of roles) expect(role.permissions).toBe(storedBitsOf(role.id));
}

const MANAGERS = [
  ['a MANAGE_ROLES holder', USERS.manager],
  ['an ADMINISTRATOR holder', USERS.administrator],
  ['the owner', USERS.owner],
  ['an instance admin', USERS.instanceAdmin],
] as const;

const NON_MANAGERS = [
  ['a plain member', USERS.member],
  ['a member whose role has overrides', USERS.vip],
  ['a MANAGE_CHANNELS holder', USERS.channelManager],
] as const;

describe('GET /api/spaces/:id', () => {
  it('refuses a non-member', async () => {
    const { status, body } = await getDetail(USERS.outsider);
    expect(status).toBe(403);
    expect(body).not.toHaveProperty('roles');
  });

  it.each(NON_MANAGERS)('gives %s every role with display fields and no bits', async (_label, userId) => {
    const { status, body } = await getDetail(userId);
    expect(status).toBe(200);
    expect(body.roles.map(r => r.id).sort()).toEqual(Object.keys(ROLE_BITS).sort());
    expect(body.roles.find(r => r.id === 'r-vip')).toMatchObject({ name: 'VIP', color: '#0000ff', position: 1, isEveryone: false });
    expectNoBits(body.roles);
  });

  it.each(MANAGERS)('gives %s every role with its stored bits', async (_label, userId) => {
    const { body } = await getDetail(userId);
    expectStoredBits(body.roles);
  });

  it('gives the member whose role has overrides their own permissions computed, and no override rows', async () => {
    const { body } = await getDetail(USERS.vip);
    const priv = body.channels.find(c => c.id === PRIVATE_ID);
    expect(stringToPermissions(priv?.myPermissions) & VIP_OVERRIDE_ALLOW).toBe(VIP_OVERRIDE_ALLOW);
    expect(priv?.isPrivate).toBe(true);
    expect(priv).not.toHaveProperty('overrides');
    expect(body.categories.find(c => c.id === CATEGORY_ID)).not.toHaveProperty('overrides');
  });

  it('lists member roles with display fields only, for every viewer', async () => {
    for (const viewer of [USERS.member, USERS.manager]) {
      const { body } = await getDetail(viewer);
      expect(body.members.find(m => m.userId === USERS.vip)?.roles.map(r => r.id)).toEqual(['r-vip']);
      for (const member of body.members) for (const role of member.roles) expect(role).not.toHaveProperty('permissions');
    }
  });
});

describe('a viewer whose home is another instance', () => {
  beforeEach(() => {
    addReplicatedMember(testDb, SPACE_ID, REPLICATED.manager, 'r-mod');
    addReplicatedMember(testDb, SPACE_ID, REPLICATED.member);
  });

  it('gets the bits and the override rows while their replicated id holds MANAGE_ROLES', async () => {
    const { status, body } = await getDetail(REPLICATED.manager.id);
    expect(status).toBe(200);
    expectStoredBits(body.roles);
    as(REPLICATED.manager.id);
    expect((await app.inject({ method: 'GET', url: `/api/channels/${PRIVATE_ID}/overrides` })).statusCode).toBe(200);
  });

  it('gets display fields only otherwise', async () => {
    const { status, body } = await getDetail(REPLICATED.member.id);
    expect(status).toBe(200);
    expectNoBits(body.roles);
    as(REPLICATED.member.id);
    expect((await app.inject({ method: 'GET', url: `/api/channels/${PRIVATE_ID}/overrides` })).statusCode).toBe(403);
  });

  it('gives no bits to the local member whose id is the manager\'s id at home', async () => {
    expectNoBits((await getDetail(USERS.member)).body.roles);
  });
});

describe('GET /api/spaces/:id/members and PATCH /api/spaces/:id/members/:uid', () => {
  it('lists member roles without bits, for a manager too', async () => {
    as(USERS.manager);
    const res = await app.inject({ method: 'GET', url: `/api/spaces/${SPACE_ID}/members` });
    expect(res.statusCode).toBe(200);
    const members = res.json<MemberWithUser[]>();
    expect(members.find(m => m.userId === USERS.vip)?.roles.map(r => r.id)).toEqual(['r-vip']);
    for (const member of members) for (const role of member.roles) expect(role).not.toHaveProperty('permissions');
  });

  it('answers a member role change with display fields only', async () => {
    as(USERS.owner);
    const res = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/members/${USERS.member}`, payload: { roleIds: ['r-vip'] },
    });
    expect(res.statusCode).toBe(200);
    const member = res.json<MemberWithUser>();
    expect(member.roles.map(r => r.id)).toEqual(['r-vip']);
    expectNoBits(member.roles);
  });
});

describe('channel and category override rows', () => {
  it.each(NON_MANAGERS)('are refused to %s', async (_label, userId) => {
    as(userId);
    for (const url of [`/api/channels/${PRIVATE_ID}/overrides`, `/api/categories/${CATEGORY_ID}/overrides`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('missing_permission');
    }
  });

  it('are refused to a non-member', async () => {
    as(USERS.outsider);
    const channel = await app.inject({ method: 'GET', url: `/api/channels/${PRIVATE_ID}/overrides` });
    expect(channel.statusCode).toBe(403);
    expect(channel.json<{ code: string }>().code).toBe('missing_permission');
    const category = await app.inject({ method: 'GET', url: `/api/categories/${CATEGORY_ID}/overrides` });
    expect(category.statusCode).toBe(403);
    expect(category.json<{ code: string }>().code).toBe('not_space_member');
  });

  it.each(MANAGERS)('are sent to %s', async (_label, userId) => {
    as(userId);
    const channel = await app.inject({ method: 'GET', url: `/api/channels/${PRIVATE_ID}/overrides` });
    expect(channel.statusCode).toBe(200);
    expect(channel.json<{ targetId: string }[]>().map(o => o.targetId).sort()).toEqual(['r-vip', SPACE_ID].sort());
    const category = await app.inject({ method: 'GET', url: `/api/categories/${CATEGORY_ID}/overrides` });
    expect(category.statusCode).toBe(200);
    expect(category.json<{ targetId: string }[]>()).toHaveLength(2);
  });
});

describe('MANAGE_ROLES allowed only by a channel override', () => {
  // MANAGE_ROLES counts at space level only (utils/permissionDataView.ts).
  beforeEach(() => {
    testDb.insert(schema.channelOverrides).values({
      channelId: GENERAL_ID, targetType: 'role', targetId: 'r-channels',
      allow: permissionsToString(PermissionBits.MANAGE_ROLES), deny: '0',
    }).run();
  });

  it('brings no role bits, though the channel lists the bit in its own permissions', async () => {
    const { body } = await getDetail(USERS.channelManager);
    const general = body.channels.find(c => c.id === GENERAL_ID);
    expect(stringToPermissions(general?.myPermissions) & PermissionBits.MANAGE_ROLES).toBe(PermissionBits.MANAGE_ROLES);
    expect(stringToPermissions(body.myPermissions) & PermissionBits.MANAGE_ROLES).toBe(0n);
    expectNoBits(body.roles);
  });

  it('does not open that channel\'s override rows for reading or for writing', async () => {
    as(USERS.channelManager);
    const read = await app.inject({ method: 'GET', url: `/api/channels/${GENERAL_ID}/overrides` });
    expect(read.statusCode).toBe(403);
    expect(read.json<{ code: string }>().code).toBe('missing_permission');

    const write = await app.inject({
      method: 'PUT', url: `/api/channels/${GENERAL_ID}/overrides`,
      payload: { targetType: 'role', targetId: 'r-vip', allow: '0', deny: '0' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json<{ code: string }>().code).toBe('missing_permission');

    const remove = await app.inject({ method: 'DELETE', url: `/api/channels/${GENERAL_ID}/overrides/role/r-channels` });
    expect(remove.statusCode).toBe(403);
    expect(remove.json<{ code: string }>().code).toBe('missing_permission');
  });
});

describe('non-members: explore, invite preview, joins', () => {
  it('lists discoverable spaces with no roles, bits or overrides', async () => {
    as(USERS.outsider);
    const res = await app.inject({ method: 'GET', url: '/api/spaces/explore' });
    expect(res.statusCode).toBe(200);
    const spaces = res.json<{ spaces: ExploreSpace[] }>().spaces;
    expect(spaces.map(s => s.id).sort()).toEqual([REQUEST_SPACE_ID, SPACE_ID].sort());
    for (const space of spaces) {
      for (const key of ['roles', 'permissions', 'myPermissions', 'channels', 'categories', 'members', 'overrides']) {
        expect(space).not.toHaveProperty(key);
      }
    }
  });

  it('previews an invite with no roles, bits or overrides', async () => {
    as(USERS.outsider);
    const res = await app.inject({ method: 'GET', url: '/api/spaces/invite/inv-roles/preview' });
    expect(res.statusCode).toBe(200);
    for (const key of ['roles', 'permissions', 'myPermissions', 'channels', 'members', 'overrides']) {
      expect(res.json()).not.toHaveProperty(key);
    }
  });

  it('answers a public join with display fields only for a member without MANAGE_ROLES', async () => {
    as(USERS.outsider);
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/public-join` });
    expect(res.statusCode).toBe(200);
    const space = res.json<SpaceWithChannelsAndMembers>();
    expect(space.roles.map(r => r.id).sort()).toEqual(Object.keys(ROLE_BITS).sort());
    expectNoBits(space.roles);
    for (const member of space.members) for (const role of member.roles) expect(role).not.toHaveProperty('permissions');
  });

  it('answers a public join with the bits when @everyone carries MANAGE_ROLES', async () => {
    testDb.update(schema.roles)
      .set({ permissions: permissionsToString(EVERYONE_BITS | PermissionBits.MANAGE_ROLES) })
      .where(eq(schema.roles.id, SPACE_ID)).run();
    as(USERS.outsider);
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/public-join` });
    const space = res.json<SpaceWithChannelsAndMembers>();
    expect(space.roles.find(r => r.id === SPACE_ID)?.permissions).toBe(permissionsToString(EVERYONE_BITS | PermissionBits.MANAGE_ROLES));
    expect(space.roles.find(r => r.id === 'r-vip')?.permissions).toBe(storedBitsOf('r-vip'));
  });

  it('sends join_request_accepted with display fields only', async () => {
    as(USERS.outsider);
    const requested = await app.inject({ method: 'POST', url: `/api/spaces/${REQUEST_SPACE_ID}/request-join`, payload: {} });
    expect(requested.statusCode).toBe(201);
    const requestId = requested.json<{ id: string }>().id;

    as(USERS.owner);
    const accepted = await app.inject({
      method: 'PATCH', url: `/api/spaces/${REQUEST_SPACE_ID}/join-requests/${requestId}`, payload: { action: 'accept' },
    });
    expect(accepted.statusCode).toBe(200);

    const event = sendToUser.mock.calls
      .filter(([userId]) => userId === USERS.outsider)
      .map(([, ev]) => ev as { type: string; space?: SpaceWithChannelsAndMembers })
      .find(ev => ev.type === 'join_request_accepted');
    expect(event?.space?.roles.map(r => r.id)).toEqual([REQUEST_SPACE_ID]);
    expectNoBits(event?.space?.roles ?? []);
  });
});

describe('role create and update answers', () => {
  it('give a manager the role with its bits', async () => {
    as(USERS.manager);
    const created = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/roles`, payload: { name: 'Helpers' } });
    expect(created.statusCode).toBe(201);
    const role = created.json<Role>();
    expect(role).toMatchObject({ name: 'Helpers', spaceId: SPACE_ID, isEveryone: false });
    expect(typeof role.permissions).toBe('string');

    const updated = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/${role.id}`, payload: { color: '#123456' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<Role>()).toMatchObject({ id: role.id, color: '#123456' });
    expect(typeof updated.json<Role>().permissions).toBe('string');
  });

  it('leave the bits out once the actor switched off their own MANAGE_ROLES', async () => {
    // The manager's MANAGE_ROLES comes from r-vip alone, a role below their
    // top role, so they may edit it and switch the bit off for themselves.
    testDb.update(schema.roles).set({ permissions: permissionsToString(PermissionBits.KICK_MEMBERS) })
      .where(eq(schema.roles.id, 'r-mod')).run();
    testDb.update(schema.roles).set({ permissions: permissionsToString(PermissionBits.KICK_MEMBERS | PermissionBits.MANAGE_ROLES) })
      .where(eq(schema.roles.id, 'r-vip')).run();
    testDb.insert(schema.memberRoles).values({ spaceId: SPACE_ID, userId: USERS.manager, roleId: 'r-vip' }).run();

    as(USERS.manager);
    const res = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/r-vip`, payload: { permissions: permissionsToString(PermissionBits.KICK_MEMBERS) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Role>()).toMatchObject({ id: 'r-vip', name: 'VIP' });
    expect(res.json<Role>()).not.toHaveProperty('permissions');
  });
});

describe('a member whose roles change', () => {
  it('is announced, and the refetch it triggers brings the bits once they manage roles', async () => {
    expectNoBits((await getDetail(USERS.member)).body.roles);

    as(USERS.owner);
    const add = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/members/${USERS.member}/roles`, payload: { roleId: 'r-mod' } });
    expect(add.statusCode).toBe(200);
    expect(announceSpaceAccessChange).toHaveBeenCalledWith(SPACE_ID, [USERS.member]);
    expectStoredBits((await getDetail(USERS.member)).body.roles);

    announceSpaceAccessChange.mockClear();
    as(USERS.owner);
    const remove = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/members/${USERS.member}/roles/r-mod` });
    expect(remove.statusCode).toBe(200);
    expect(announceSpaceAccessChange).toHaveBeenCalledWith(SPACE_ID, [USERS.member]);
    expectNoBits((await getDetail(USERS.member)).body.roles);
  });

  it('is announced after PATCH /members/:uid too', async () => {
    as(USERS.owner);
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/members/${USERS.member}`, payload: { roleIds: ['r-mod'] } });
    expect(res.statusCode).toBe(200);
    expect(announceSpaceAccessChange).toHaveBeenCalledWith(SPACE_ID, [USERS.member]);
    expectStoredBits((await getDetail(USERS.member)).body.roles);
  });
});

describe('an ownership transfer', () => {
  it('is announced for the former and the new owner, and their refetches carry or drop the bits', async () => {
    expectStoredBits((await getDetail(USERS.owner)).body.roles);
    expectNoBits((await getDetail(USERS.member)).body.roles);

    as(USERS.owner);
    const res = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/transfer-ownership`, payload: { newOwnerId: USERS.member },
    });
    expect(res.statusCode).toBe(200);
    expect(announceSpaceAccessChange).toHaveBeenCalledTimes(1);
    expect(announceSpaceAccessChange).toHaveBeenCalledWith(SPACE_ID, [USERS.owner, USERS.member]);

    expectNoBits((await getDetail(USERS.owner)).body.roles);
    expect(stringToPermissions((await getDetail(USERS.owner)).body.myPermissions) & PermissionBits.MANAGE_ROLES).toBe(0n);
    expectStoredBits((await getDetail(USERS.member)).body.roles);
  });

  it('announces nothing when refused', async () => {
    as(USERS.manager);
    const res = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/transfer-ownership`, payload: { newOwnerId: USERS.member },
    });
    expect(res.statusCode).toBe(403);
    expect(announceSpaceAccessChange).not.toHaveBeenCalled();
  });
});

describe('an instance admin change', () => {
  function setAdmin(userId: string, isAdmin: boolean) {
    as(USERS.instanceAdmin);
    return app.inject({ method: 'PATCH', url: `/api/admin/users/${userId}/role`, payload: { isAdmin } });
  }

  it('is announced to the promoted user alone, once for each of their spaces, and their refetch carries the bits', async () => {
    testDb.insert(schema.spaceMembers).values({ spaceId: REQUEST_SPACE_ID, userId: USERS.member, joinedAt: 1 }).run();
    expectNoBits((await getDetail(USERS.member)).body.roles);

    expect((await setAdmin(USERS.member, true)).statusCode).toBe(200);
    expect(announceUserAccessChange).toHaveBeenCalledTimes(1);
    const [userId, spaceIds] = announceUserAccessChange.mock.calls[0] as [string, string[]];
    expect(userId).toBe(USERS.member);
    expect([...spaceIds].sort()).toEqual([REQUEST_SPACE_ID, SPACE_ID].sort());
    expect(announceSpaceAccessChange).not.toHaveBeenCalled();

    expectStoredBits((await getDetail(USERS.member)).body.roles);
  });

  it('is announced to the demoted user, and their refetch drops the bits', async () => {
    expect((await setAdmin(USERS.member, true)).statusCode).toBe(200);
    announceUserAccessChange.mockClear();

    expect((await setAdmin(USERS.member, false)).statusCode).toBe(200);
    expect(announceUserAccessChange).toHaveBeenCalledTimes(1);
    expect(announceUserAccessChange).toHaveBeenCalledWith(USERS.member, [SPACE_ID]);

    expectNoBits((await getDetail(USERS.member)).body.roles);
  });

  it('announces nothing when the flag does not change', async () => {
    expect((await setAdmin(USERS.member, false)).statusCode).toBe(200);
    expect(announceUserAccessChange).not.toHaveBeenCalled();
  });
});
