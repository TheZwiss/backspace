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
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';

// #299: moderation follows the role hierarchy. The owner is exempt and never
// a target; otherwise the actor's top role must sit strictly above the
// target's, and roles can only be handed out, edited or moved below one's own
// top role.

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
const now = 1_700_000_000_000;
const MODERATION = permissionsToString(
  PermissionBits.KICK_MEMBERS | PermissionBits.BAN_MEMBERS | PermissionBits.MANAGE_ROLES,
);

let app: FastifyInstance;

function addUser(id: string, extra: Partial<typeof schema.users.$inferInsert> = {}): void {
  testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: now, ...extra }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: id, joinedAt: now }).run();
}

function assign(userId: string, roleId: string): void {
  testDb.insert(schema.memberRoles).values({ spaceId: SPACE_ID, userId, roleId }).run();
}

function positions(): Record<string, number> {
  const rows = testDb.select().from(schema.roles).where(eq(schema.roles.spaceId, SPACE_ID)).all();
  return Object.fromEntries(rows.map(r => [r.id, r.position ?? 0]));
}

function isMember(userId: string): boolean {
  return !!testDb.select().from(schema.spaceMembers)
    .where(and(eq(schema.spaceMembers.spaceId, SPACE_ID), eq(schema.spaceMembers.userId, userId))).get();
}

function rolesOf(userId: string): string[] {
  return testDb.select().from(schema.memberRoles)
    .where(and(eq(schema.memberRoles.spaceId, SPACE_ID), eq(schema.memberRoles.userId, userId)))
    .all().map(r => r.roleId).sort();
}

function as(userId: string): void {
  currentUserId = userId;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  testDb.insert(schema.users).values({ id: 'owner', username: 'owner', passwordHash: 'x', createdAt: now }).run();
  testDb.insert(schema.spaces).values({
    id: SPACE_ID, name: 'Space', ownerId: 'owner', inviteCode: 'code', visibility: 'public', createdAt: now,
  }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: 'owner', joinedAt: now }).run();

  // Highest first: Moderators 3, Helpers 2, Members 1, @everyone 0.
  testDb.insert(schema.roles).values([
    { id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', position: 0, permissions: permissionsToString(PermissionBits.VIEW_CHANNEL), createdAt: now },
    { id: 'r-mod', spaceId: SPACE_ID, name: 'Moderators', position: 3, permissions: MODERATION, createdAt: now },
    { id: 'r-helper', spaceId: SPACE_ID, name: 'Helpers', position: 2, permissions: MODERATION, createdAt: now },
    { id: 'r-member', spaceId: SPACE_ID, name: 'Members', position: 1, permissions: '0', createdAt: now },
  ]).run();

  addUser('mod');
  assign('mod', 'r-mod');
  addUser('mod-2');
  assign('mod-2', 'r-mod');
  addUser('helper');
  assign('helper', 'r-helper');
  addUser('member');
  assign('member', 'r-member');
  addUser('plain');
  addUser('instance-admin', { isAdmin: 1 });
  // A helper whose home is another instance. On this instance they are the
  // local replicated user their session authenticates as.
  addUser('fed-helper', { username: 'fed@orbit.example', homeInstance: 'orbit.example', homeUserId: 'orbit-id-of-fed' });
  assign('fed-helper', 'r-helper');

  const { spaceRoutes } = await import('./spaces.js');
  app = Fastify();
  await app.register(spaceRoutes);
});

async function kick(target: string) {
  return app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/members/${target}` });
}

async function ban(target: string) {
  return app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/bans`, payload: { userId: target } });
}

function expectHierarchyRefusal(res: Awaited<ReturnType<typeof kick>>): void {
  expect(res.statusCode).toBe(403);
  expect(res.json<{ code: string }>().code).toBe('role_hierarchy');
}

describe('kick and ban follow the role hierarchy', () => {
  it('refuses a helper kicking a moderator, and allows the reverse', async () => {
    as('helper');
    expectHierarchyRefusal(await kick('mod'));
    expect(isMember('mod')).toBe(true);

    as('mod');
    expect((await kick('helper')).statusCode).toBe(200);
    expect(isMember('helper')).toBe(false);
  });

  it('refuses a moderator acting on another moderator at the same rank', async () => {
    as('mod');
    expectHierarchyRefusal(await kick('mod-2'));
    expectHierarchyRefusal(await ban('mod-2'));
  });

  it('lets a helper remove members below them and members with no role', async () => {
    as('helper');
    expect((await kick('member')).statusCode).toBe(200);
    expect((await ban('plain')).statusCode).toBe(200);
  });

  it('refuses a helper banning a moderator', async () => {
    as('helper');
    expectHierarchyRefusal(await ban('mod'));
    expect(isMember('mod')).toBe(true);
  });

  it('exempts the owner and instance admins, and nobody acts on the owner', async () => {
    as('owner');
    expect((await kick('mod')).statusCode).toBe(200);
    as('instance-admin');
    expect((await ban('mod-2')).statusCode).toBe(200);
    as('helper');
    expect((await kick('owner')).json<{ code: string }>().code).toBe('cannot_target_owner');
    expect((await ban('owner')).json<{ code: string }>().code).toBe('cannot_target_owner');
  });

  it('ranks a federated moderator by their local replicated user', async () => {
    as('fed-helper');
    expectHierarchyRefusal(await kick('mod'));
    expect((await kick('member')).statusCode).toBe(200);
  });
});

describe('role assignment follows the role hierarchy', () => {
  async function setRoles(target: string, roleIds: string[]) {
    return app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/members/${target}`, payload: { roleIds } });
  }

  it('refuses handing out a role at or above the actor\'s top role', async () => {
    as('helper');
    expectHierarchyRefusal(await setRoles('plain', ['r-helper']));
    expectHierarchyRefusal(await setRoles('plain', ['r-mod']));
    expect(rolesOf('plain')).toEqual([]);
  });

  it('allows handing out and taking back a role below the actor\'s top role', async () => {
    as('helper');
    expect((await setRoles('plain', ['r-member'])).statusCode).toBe(200);
    expect(rolesOf('plain')).toEqual(['r-member']);
    expect((await setRoles('plain', [])).statusCode).toBe(200);
    expect(rolesOf('plain')).toEqual([]);
  });

  it('refuses changing the roles of a member ranked at or above the actor', async () => {
    as('helper');
    expectHierarchyRefusal(await setRoles('mod', ['r-mod', 'r-member']));
    expect(rolesOf('mod')).toEqual(['r-mod']);
  });

  it('applies the same rule to the single-role routes', async () => {
    as('helper');
    const add = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/members/plain/roles`, payload: { roleId: 'r-helper' } });
    expectHierarchyRefusal(add);
    const remove = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/members/mod/roles/r-mod` });
    expectHierarchyRefusal(remove);
    expect(rolesOf('mod')).toEqual(['r-mod']);

    const ok = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/members/plain/roles`, payload: { roleId: 'r-member' } });
    expect(ok.statusCode).toBe(200);
    expect(rolesOf('plain')).toEqual(['r-member']);
  });

  it('refuses a role id from another space on the single-role route', async () => {
    testDb.insert(schema.spaces).values({ id: 'space-2', name: 'Other', ownerId: 'owner', inviteCode: 'c2', visibility: 'public', createdAt: now }).run();
    testDb.insert(schema.roles).values({ id: 'r-other', spaceId: 'space-2', name: 'Other', position: 1, permissions: '0', createdAt: now }).run();
    as('owner');
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/members/plain/roles`, payload: { roleId: 'r-other' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('role_not_in_space');
    expect(rolesOf('plain')).toEqual([]);
  });
});

describe('role management follows the role hierarchy', () => {
  it('refuses editing or deleting a role at or above the actor\'s top role', async () => {
    as('helper');
    expectHierarchyRefusal(await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/r-mod`, payload: { permissions: '0' } }));
    expectHierarchyRefusal(await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/r-helper`, payload: { name: 'Big helpers' } }));
    expectHierarchyRefusal(await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/roles/r-mod` }));
    expect(positions()['r-mod']).toBe(3);
  });

  it('allows editing a role below the actor\'s top role', async () => {
    as('helper');
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/r-member`, payload: { color: '#a5f3c4' } });
    expect(res.statusCode).toBe(200);
  });

  it('refuses moving a role to or above the actor\'s top role', async () => {
    as('helper');
    expectHierarchyRefusal(await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/r-member`, payload: { position: 2 } }));
    expect(positions()).toMatchObject({ 'r-mod': 3, 'r-helper': 2, 'r-member': 1 });
  });

  it('moves a role and renumbers the others so every position stays distinct', async () => {
    as('owner');
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/r-member`, payload: { position: 3 } });
    expect(res.statusCode).toBe(200);
    expect(positions()).toEqual({ [SPACE_ID]: 0, 'r-member': 3, 'r-mod': 2, 'r-helper': 1 });
  });

  it('lets a MANAGE_ROLES member reorder the roles below their own, and no higher', async () => {
    // Moderators 4, Helpers 3, Members 2, Guests 1: the helper manages 2 and 1.
    testDb.insert(schema.roles).values({ id: 'r-guest', spaceId: SPACE_ID, name: 'Guests', position: 0, permissions: '0', createdAt: now + 1 }).run();
    const { normalizeRolePositions } = await import('../db/rolePositions.js');
    normalizeRolePositions(sqlite, SPACE_ID);
    expect(positions()).toMatchObject({ 'r-mod': 4, 'r-helper': 3, 'r-member': 2, 'r-guest': 1 });

    as('helper');
    const move = (roleId: string, position: number) =>
      app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/${roleId}`, payload: { position } });

    const ok = await move('r-guest', 2);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ id: string; position: number }>()).toMatchObject({ id: 'r-guest', position: 2 });
    expect(positions()).toEqual({ [SPACE_ID]: 0, 'r-mod': 4, 'r-helper': 3, 'r-guest': 2, 'r-member': 1 });

    // Up to their own rank, their own role, and a role above them: refused, nothing moves.
    expectHierarchyRefusal(await move('r-member', 3));
    expectHierarchyRefusal(await move('r-helper', 1));
    expectHierarchyRefusal(await move('r-mod', 1));
    expect(positions()).toEqual({ [SPACE_ID]: 0, 'r-mod': 4, 'r-helper': 3, 'r-guest': 2, 'r-member': 1 });

    // @everyone stays at the bottom.
    const everyone = await move(SPACE_ID, 1);
    expect(everyone.statusCode).toBe(400);
    expect(positions()[SPACE_ID]).toBe(0);
  });

  it('pushes every member a ready payload after a move, which reloads their open role list', async () => {
    const { connectionManager } = await import('../ws/handler.js');
    const push = vi.mocked(connectionManager.pushReadyPayload);
    push.mockClear();
    as('owner');
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/r-member`, payload: { position: 2 } });
    expect(res.statusCode).toBe(200);
    const pushedTo = new Set(push.mock.calls.map(([userId]) => userId));
    for (const userId of ['owner', 'mod', 'mod-2', 'helper', 'member', 'plain', 'instance-admin', 'fed-helper']) {
      expect(pushedTo.has(userId)).toBe(true);
    }
  });

  it('creates a new role at the bottom, just above @everyone', async () => {
    as('helper');
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/roles`, payload: { name: 'Fresh' } });
    expect(res.statusCode).toBe(201);
    const fresh = res.json<{ id: string; position: number }>();
    expect(fresh.position).toBe(1);
    expect(positions()).toMatchObject({ [SPACE_ID]: 0, 'r-mod': 4, 'r-helper': 3, 'r-member': 2, [fresh.id]: 1 });
  });
});

describe('normalizeRolePositions', () => {
  it('turns roles that all sit at 0 into distinct positions in creation order, oldest highest', async () => {
    const { normalizeRolePositions } = await import('../db/rolePositions.js');
    testDb.update(schema.roles).set({ position: 0 }).where(eq(schema.roles.spaceId, SPACE_ID)).run();
    testDb.update(schema.roles).set({ createdAt: now + 1 }).where(eq(schema.roles.id, 'r-helper')).run();
    testDb.update(schema.roles).set({ createdAt: now + 2 }).where(eq(schema.roles.id, 'r-member')).run();

    normalizeRolePositions(sqlite, SPACE_ID);
    expect(positions()).toEqual({ [SPACE_ID]: 0, 'r-mod': 3, 'r-helper': 2, 'r-member': 1 });

    normalizeRolePositions(sqlite, SPACE_ID);
    expect(positions()).toEqual({ [SPACE_ID]: 0, 'r-mod': 3, 'r-helper': 2, 'r-member': 1 });
  });
});
