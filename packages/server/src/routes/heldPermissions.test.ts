import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  PermissionBits,
  permissionsToString,
  stringToPermissions,
} from '@backspace/shared/src/permissions.js';

// #299, role management: the role hierarchy decides WHICH roles and members a
// MANAGE_ROLES holder may touch; the held-bits rule decides WHICH permission
// bits they may switch on those roles and on channel and category overrides:
// only bits they hold in the space themselves. The owner, instance admins and
// ADMINISTRATOR holders hold every bit.
//
// The first block is the escalation a review reproduced on main: a member
// whose only power is MANAGE_ROLES on a position-1 role could take a senior
// member's role away, hand out ADMINISTRATOR, give their own role
// ADMINISTRATOR, clear a higher role and give @everyone every bit.

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'owner';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    addUserSpace: vi.fn(),
    sendToSpace: vi.fn(),
    sendToUser: vi.fn(),
    pushReadyPayload: vi.fn(),
    getUserSpaceEntries: () => new Map<string, Set<string>>().entries(),
  },
}));

vi.mock('../ws/events.js', () => ({
  checkVoicePermissions: vi.fn(),
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const SPACE_ID = 'space-1';
const CHANNEL_ID = 'channel-1';
const CATEGORY_ID = 'category-1';
const now = 1_700_000_000_000;

const EVERYONE_BITS = PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES;
// The lead holds MANAGE_ROLES and KICK_MEMBERS, not MANAGE_MESSAGES, BAN_MEMBERS or ADMINISTRATOR.
const LEAD_BITS = PermissionBits.MANAGE_ROLES | PermissionBits.KICK_MEMBERS;

let app: FastifyInstance;

function addUser(id: string, roleId?: string, extra: Partial<typeof schema.users.$inferInsert> = {}): void {
  testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: now, ...extra }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: id, joinedAt: now }).run();
  if (roleId) testDb.insert(schema.memberRoles).values({ spaceId: SPACE_ID, userId: id, roleId }).run();
}

function rolesOf(userId: string): string[] {
  return testDb.select().from(schema.memberRoles)
    .where(and(eq(schema.memberRoles.spaceId, SPACE_ID), eq(schema.memberRoles.userId, userId)))
    .all().map(r => r.roleId).sort();
}

function rolePermissions(roleId: string): bigint {
  const row = testDb.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();
  return stringToPermissions(row?.permissions);
}

function channelOverride(targetId: string) {
  return testDb.select().from(schema.channelOverrides).where(and(
    eq(schema.channelOverrides.channelId, CHANNEL_ID),
    eq(schema.channelOverrides.targetType, 'role'),
    eq(schema.channelOverrides.targetId, targetId),
  )).get();
}

function categoryOverride(targetId: string) {
  return testDb.select().from(schema.categoryOverrides).where(and(
    eq(schema.categoryOverrides.categoryId, CATEGORY_ID),
    eq(schema.categoryOverrides.targetType, 'role'),
    eq(schema.categoryOverrides.targetId, targetId),
  )).get();
}

function as(userId: string): void {
  currentUserId = userId;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  currentUserId = 'owner';

  testDb.insert(schema.users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: now }).run();
  testDb.insert(schema.spaces).values({
    id: SPACE_ID, name: 'Space', ownerId: 'owner', inviteCode: 'code', visibility: 'public', createdAt: now,
  }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: 'owner', joinedAt: now }).run();

  // Highest first: Lead 3, Admins 2 (ADMINISTRATOR), Mods 1 (MANAGE_ROLES only), @everyone 0.
  testDb.insert(schema.roles).values([
    { id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', position: 0, permissions: permissionsToString(EVERYONE_BITS), createdAt: now },
    { id: 'r-lead', spaceId: SPACE_ID, name: 'Lead', position: 3, permissions: permissionsToString(LEAD_BITS), createdAt: now },
    { id: 'r-admin', spaceId: SPACE_ID, name: 'Admins', position: 2, permissions: permissionsToString(PermissionBits.ADMINISTRATOR), createdAt: now },
    { id: 'r-mod', spaceId: SPACE_ID, name: 'Mods', position: 1, permissions: permissionsToString(PermissionBits.MANAGE_ROLES), createdAt: now },
  ]).run();

  addUser('lead', 'r-lead');
  addUser('senior', 'r-admin');
  addUser('mod', 'r-mod');
  addUser('alt');
  addUser('instance-admin', undefined, { isAdmin: 1 });

  testDb.insert(schema.channelCategories).values({ id: CATEGORY_ID, spaceId: SPACE_ID, name: 'cat', position: 0, createdAt: now }).run();
  testDb.insert(schema.channels).values({ id: CHANNEL_ID, spaceId: SPACE_ID, name: 'general', type: 'text', position: 0, categoryId: CATEGORY_ID, createdAt: now }).run();

  const { spaceRoutes } = await import('./spaces.js');
  const { channelRoutes } = await import('./channels.js');
  app = Fastify();
  await app.register(spaceRoutes);
  await app.register(channelRoutes);
});

type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

function expectRefusal(res: Res, code: string): void {
  expect(res.statusCode).toBe(403);
  expect(res.json<{ code: string }>().code).toBe(code);
}

function patchRole(roleId: string, payload: Record<string, unknown>): Promise<Res> {
  return app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/${roleId}`, payload });
}

function setMemberRoles(userId: string, roleIds: string[]): Promise<Res> {
  return app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/members/${userId}`, payload: { roleIds } });
}

function createRole(payload: Record<string, unknown>): Promise<Res> {
  return app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/roles`, payload });
}

function putChannelOverride(targetId: string, allow: bigint, deny: bigint): Promise<Res> {
  return app.inject({
    method: 'PUT',
    url: `/api/channels/${CHANNEL_ID}/overrides`,
    payload: { targetType: 'role', targetId, allow: permissionsToString(allow), deny: permissionsToString(deny) },
  });
}

function deleteChannelOverride(targetId: string): Promise<Res> {
  return app.inject({ method: 'DELETE', url: `/api/channels/${CHANNEL_ID}/overrides/role/${targetId}` });
}

function putCategoryOverride(targetId: string, allow: bigint, deny: bigint): Promise<Res> {
  return app.inject({
    method: 'PUT',
    url: `/api/categories/${CATEGORY_ID}/overrides`,
    payload: { targetType: 'role', targetId, allow: permissionsToString(allow), deny: permissionsToString(deny) },
  });
}

function deleteCategoryOverride(targetId: string): Promise<Res> {
  return app.inject({ method: 'DELETE', url: `/api/categories/${CATEGORY_ID}/overrides/role/${targetId}` });
}

describe('a MANAGE_ROLES holder at position 1 cannot escalate', () => {
  it('(a) cannot take a higher member\'s role away', async () => {
    as('mod');
    expectRefusal(await setMemberRoles('senior', []), 'role_hierarchy');
    const single = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/members/senior/roles/r-admin` });
    expectRefusal(single, 'role_hierarchy');
    expect(rolesOf('senior')).toEqual(['r-admin']);
  });

  it('(b) cannot hand a higher role such as ADMINISTRATOR to anyone', async () => {
    as('mod');
    expectRefusal(await setMemberRoles('alt', ['r-admin']), 'role_hierarchy');
    const single = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/members/alt/roles`, payload: { roleId: 'r-admin' } });
    expectRefusal(single, 'role_hierarchy');
    expect(rolesOf('alt')).toEqual([]);
  });

  it('(c) cannot add ADMINISTRATOR to their own role', async () => {
    as('mod');
    const bits = PermissionBits.MANAGE_ROLES | PermissionBits.ADMINISTRATOR;
    expectRefusal(await patchRole('r-mod', { permissions: permissionsToString(bits) }), 'role_hierarchy');
    expect(rolePermissions('r-mod')).toBe(PermissionBits.MANAGE_ROLES);
  });

  it('(d) cannot clear a higher role\'s permissions', async () => {
    as('mod');
    expectRefusal(await patchRole('r-admin', { permissions: '0' }), 'role_hierarchy');
    expect(rolePermissions('r-admin')).toBe(PermissionBits.ADMINISTRATOR);
  });

  it('(e) cannot give @everyone bits they do not hold', async () => {
    as('mod');
    expectRefusal(await patchRole(SPACE_ID, { permissions: permissionsToString(ALL_PERMISSIONS) }), 'cannot_grant_unowned_permissions');
    expectRefusal(
      await patchRole(SPACE_ID, { permissions: permissionsToString(EVERYONE_BITS | PermissionBits.ADMINISTRATOR) }),
      'cannot_grant_unowned_permissions',
    );
    expect(rolePermissions(SPACE_ID)).toBe(EVERYONE_BITS);
  });

  it('may still give @everyone a bit they hold', async () => {
    as('mod');
    const res = await patchRole(SPACE_ID, { permissions: permissionsToString(EVERYONE_BITS | PermissionBits.MANAGE_ROLES) });
    expect(res.statusCode).toBe(200);
    expect(rolePermissions(SPACE_ID)).toBe(EVERYONE_BITS | PermissionBits.MANAGE_ROLES);
  });

  it('the owner and self cases stay as they were', async () => {
    as('mod');
    const self = await setMemberRoles('mod', []);
    expect(self.statusCode).toBe(400);
    expect(self.json<{ code: string }>().code).toBe('cannot_change_own_roles');
    const owner = await setMemberRoles('owner', ['r-mod']);
    expectRefusal(owner, 'space_owner_only');

    as('owner');
    expect((await setMemberRoles('alt', ['r-admin'])).statusCode).toBe(200);
    expect((await patchRole(SPACE_ID, { permissions: permissionsToString(ALL_PERMISSIONS) })).statusCode).toBe(200);
  });
});

describe('PATCH /roles/:roleId with a role id from another space', () => {
  it('answers 404 and does not echo the other space\'s role', async () => {
    testDb.insert(schema.spaces).values({ id: 'space-2', name: 'Other', ownerId: 'owner', inviteCode: 'c2', visibility: 'public', createdAt: now }).run();
    testDb.insert(schema.roles).values({ id: 'r-foreign', spaceId: 'space-2', name: 'Secret', position: 1, permissions: '8', createdAt: now }).run();
    as('owner');
    const res = await patchRole('r-foreign', { color: '#ffffff' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('role_not_in_space');
    expect(res.body).not.toContain('Secret');
    const foreign = testDb.select().from(schema.roles).where(eq(schema.roles.id, 'r-foreign')).get();
    expect(foreign?.color).not.toBe('#ffffff');
  });
});

describe('role permissions: only bits the actor holds can be switched', () => {
  it('refuses switching on a bit the actor lacks, with cannot_grant_unowned_permissions', async () => {
    as('lead');
    expectRefusal(
      await patchRole('r-mod', { permissions: permissionsToString(PermissionBits.MANAGE_ROLES | PermissionBits.BAN_MEMBERS) }),
      'cannot_grant_unowned_permissions',
    );
    expect(rolePermissions('r-mod')).toBe(PermissionBits.MANAGE_ROLES);
  });

  it('refuses switching off a bit the actor lacks, with cannot_change_unowned_permissions', async () => {
    as('lead');
    expectRefusal(await patchRole('r-admin', { permissions: '0' }), 'cannot_change_unowned_permissions');
    expect(rolePermissions('r-admin')).toBe(PermissionBits.ADMINISTRATOR);
  });

  it('allows switching bits the actor holds, and leaves unheld bits already on the role in place', async () => {
    as('lead');
    const onMods = await patchRole('r-mod', { permissions: permissionsToString(PermissionBits.MANAGE_ROLES | PermissionBits.KICK_MEMBERS) });
    expect(onMods.statusCode).toBe(200);
    expect(rolePermissions('r-mod')).toBe(PermissionBits.MANAGE_ROLES | PermissionBits.KICK_MEMBERS);

    // Admins keeps ADMINISTRATOR, which the lead cannot touch, while the lead adds KICK_MEMBERS.
    const onAdmins = await patchRole('r-admin', {
      name: 'Admins+',
      permissions: permissionsToString(PermissionBits.ADMINISTRATOR | PermissionBits.KICK_MEMBERS),
    });
    expect(onAdmins.statusCode).toBe(200);
    expect(rolePermissions('r-admin')).toBe(PermissionBits.ADMINISTRATOR | PermissionBits.KICK_MEMBERS);
  });

  it('refuses a malformed or negative permissions value', async () => {
    as('owner');
    for (const permissions of ['nope', '-1']) {
      const res = await patchRole('r-mod', { permissions });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('permissions_invalid');
    }
  });

  it('treats a non-owner ADMINISTRATOR holder as holding every bit, below their own rank', async () => {
    as('senior');
    const res = await patchRole('r-mod', { permissions: permissionsToString(PermissionBits.MANAGE_ROLES | PermissionBits.BAN_MEMBERS) });
    expect(res.statusCode).toBe(200);
    expectRefusal(await patchRole('r-lead', { permissions: '0' }), 'role_hierarchy');
  });

  it('exempts the owner and instance admins', async () => {
    as('instance-admin');
    expect((await patchRole('r-lead', { permissions: permissionsToString(ALL_PERMISSIONS) })).statusCode).toBe(200);
    as('owner');
    expect((await patchRole('r-lead', { permissions: '0' })).statusCode).toBe(200);
  });

  it('refuses creating a role with bits the actor lacks, and trims the default to what they hold', async () => {
    as('lead');
    expectRefusal(
      await createRole({ name: 'Bans', permissions: permissionsToString(PermissionBits.BAN_MEMBERS) }),
      'cannot_grant_unowned_permissions',
    );
    expectRefusal(
      await createRole({ name: 'Admins 2', permissions: permissionsToString(PermissionBits.ADMINISTRATOR) }),
      'cannot_grant_unowned_permissions',
    );

    const plain = await createRole({ name: 'Plain' });
    expect(plain.statusCode).toBe(201);
    const held = EVERYONE_BITS | LEAD_BITS;
    expect(stringToPermissions(plain.json<{ permissions: string }>().permissions)).toBe(DEFAULT_EVERYONE_PERMISSIONS & held);

    const kickers = await createRole({ name: 'Kickers', permissions: permissionsToString(PermissionBits.KICK_MEMBERS) });
    expect(kickers.statusCode).toBe(201);
  });
});

describe('channel overrides: only bits the actor holds can be switched', () => {
  it('refuses allowing or denying a bit the actor lacks', async () => {
    as('lead');
    expectRefusal(await putChannelOverride('r-mod', PermissionBits.MANAGE_MESSAGES, 0n), 'cannot_grant_unowned_permissions');
    expectRefusal(await putChannelOverride('r-mod', 0n, PermissionBits.MANAGE_MESSAGES), 'cannot_deny_unowned_permissions');
    expect(channelOverride('r-mod')).toBeUndefined();
  });

  it('keeps an unheld bit someone senior set while the actor edits the bits they hold', async () => {
    as('owner');
    expect((await putChannelOverride('r-mod', PermissionBits.MANAGE_MESSAGES, 0n)).statusCode).toBe(200);

    as('lead');
    const res = await putChannelOverride('r-mod', PermissionBits.MANAGE_MESSAGES, PermissionBits.SEND_MESSAGES);
    expect(res.statusCode).toBe(200);
    expect(stringToPermissions(channelOverride('r-mod')?.deny)).toBe(PermissionBits.SEND_MESSAGES);
  });

  it('refuses clearing an unheld bit, and deleting an override that holds one', async () => {
    as('owner');
    expect((await putChannelOverride('r-mod', PermissionBits.MANAGE_MESSAGES, PermissionBits.SEND_MESSAGES)).statusCode).toBe(200);

    as('lead');
    expectRefusal(await putChannelOverride('r-mod', 0n, PermissionBits.SEND_MESSAGES), 'cannot_change_unowned_permissions');
    expectRefusal(await deleteChannelOverride('r-mod'), 'cannot_change_unowned_permissions');
    expect(stringToPermissions(channelOverride('r-mod')?.allow)).toBe(PermissionBits.MANAGE_MESSAGES);
  });

  it('deletes an override that only holds bits the actor holds', async () => {
    as('owner');
    expect((await putChannelOverride(SPACE_ID, 0n, PermissionBits.VIEW_CHANNEL)).statusCode).toBe(200);
    as('lead');
    expect((await deleteChannelOverride(SPACE_ID)).statusCode).toBe(200);
    expect(channelOverride(SPACE_ID)).toBeUndefined();
  });

  it('lets an ADMINISTRATOR holder switch any bit', async () => {
    as('senior');
    expect((await putChannelOverride('r-mod', PermissionBits.MANAGE_MESSAGES, PermissionBits.BAN_MEMBERS)).statusCode).toBe(200);
    expect((await deleteChannelOverride('r-mod')).statusCode).toBe(200);
  });
});

describe('category overrides: only bits the actor holds can be switched', () => {
  it('applies the same rule as channel overrides', async () => {
    as('lead');
    expectRefusal(await putCategoryOverride('r-mod', PermissionBits.MANAGE_MESSAGES, 0n), 'cannot_grant_unowned_permissions');
    expectRefusal(await putCategoryOverride('r-mod', 0n, PermissionBits.BAN_MEMBERS), 'cannot_deny_unowned_permissions');

    as('owner');
    expect((await putCategoryOverride('r-mod', PermissionBits.MANAGE_MESSAGES, 0n)).statusCode).toBe(200);

    as('lead');
    expect((await putCategoryOverride('r-mod', PermissionBits.MANAGE_MESSAGES, PermissionBits.SEND_MESSAGES)).statusCode).toBe(200);
    expectRefusal(await putCategoryOverride('r-mod', 0n, 0n), 'cannot_change_unowned_permissions');
    expectRefusal(await deleteCategoryOverride('r-mod'), 'cannot_change_unowned_permissions');
    expect(stringToPermissions(categoryOverride('r-mod')?.allow)).toBe(PermissionBits.MANAGE_MESSAGES);
  });
});

describe('giving a member a role: the role\'s bits must be held (review probe P1)', () => {
  it('refuses handing out a lower role that carries a bit the actor lacks', async () => {
    as('lead');
    expectRefusal(await setMemberRoles('alt', ['r-admin']), 'cannot_grant_unowned_permissions');
    const single = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/members/alt/roles`, payload: { roleId: 'r-admin' } });
    expectRefusal(single, 'cannot_grant_unowned_permissions');
    expect(rolesOf('alt')).toEqual([]);
  });

  it('still hands out a lower role whose bits the actor holds', async () => {
    as('lead');
    expect((await setMemberRoles('alt', ['r-mod'])).statusCode).toBe(200);
    expect(rolesOf('alt')).toEqual(['r-mod']);
  });

  it('keeps a role the member already has when the actor changes their other roles', async () => {
    testDb.insert(schema.memberRoles).values({ spaceId: SPACE_ID, userId: 'alt', roleId: 'r-admin' }).run();
    as('lead');
    expect((await setMemberRoles('alt', ['r-admin', 'r-mod'])).statusCode).toBe(200);
    expect(rolesOf('alt')).toEqual(['r-admin', 'r-mod']);
  });

  it('lets the actor take such a role from a member ranked below them: the hierarchy alone governs removal', async () => {
    as('lead');
    expect((await setMemberRoles('senior', [])).statusCode).toBe(200);
    expect(rolesOf('senior')).toEqual([]);
  });

  it('lets the owner hand it out', async () => {
    as('owner');
    expect((await setMemberRoles('alt', ['r-admin'])).statusCode).toBe(200);
  });
});

describe('deleting a role: its bits must be held (review probe P3)', () => {
  function deleteRole(roleId: string): Promise<Res> {
    return app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/roles/${roleId}` });
  }

  it('refuses deleting a lower role that carries a bit the actor lacks', async () => {
    as('lead');
    expectRefusal(await deleteRole('r-admin'), 'cannot_change_unowned_permissions');
    expect(rolePermissions('r-admin')).toBe(PermissionBits.ADMINISTRATOR);
    expect(rolesOf('senior')).toEqual(['r-admin']);
  });

  it('deletes a lower role whose bits the actor holds, and the owner deletes any', async () => {
    as('lead');
    expect((await deleteRole('r-mod')).statusCode).toBe(200);
    as('owner');
    expect((await deleteRole('r-admin')).statusCode).toBe(200);
  });
});
