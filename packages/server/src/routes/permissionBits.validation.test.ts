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

// #365: the request boundary of the role and override routes. A permissions
// value is a canonical non-negative decimal string, and a member's role list
// is a list of distinct role ids; anything else is a 400 with an ErrorCode,
// never a 500 and never a raw string in the database.
//
// #374: a role or member-role change tells the space's members with one
// `space_access_changed` event instead of pushing each of them a whole
// `ready` payload. The mock below has no `pushReadyPayload`, so a route that
// still calls it answers 500.

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

const sendToSpace = vi.fn();
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    addUserSpace: vi.fn(),
    sendToSpace: (...args: unknown[]) => sendToSpace(...args),
    sendToUser: vi.fn(),
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

let app: FastifyInstance;

beforeEach(async () => {
  sendToSpace.mockClear();
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  currentUserId = 'owner';

  for (const id of ['owner', 'member']) {
    testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: now }).run();
  }
  testDb.insert(schema.spaces).values({
    id: SPACE_ID, name: 'Space', ownerId: 'owner', inviteCode: 'code', visibility: 'public', createdAt: now,
  }).run();
  for (const userId of ['owner', 'member']) {
    testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId, joinedAt: now }).run();
  }
  testDb.insert(schema.roles).values([
    { id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', position: 0, permissions: permissionsToString(PermissionBits.VIEW_CHANNEL), createdAt: now },
    { id: 'r-mod', spaceId: SPACE_ID, name: 'Moderators', position: 2, permissions: '0', createdAt: now },
    { id: 'r-member', spaceId: SPACE_ID, name: 'Members', position: 1, permissions: '0', createdAt: now },
  ]).run();
  testDb.insert(schema.channelCategories).values({ id: CATEGORY_ID, spaceId: SPACE_ID, name: 'cat', position: 0, createdAt: now }).run();
  testDb.insert(schema.channels).values({ id: CHANNEL_ID, spaceId: SPACE_ID, name: 'general', type: 'text', position: 0, categoryId: CATEGORY_ID, createdAt: now }).run();

  const { spaceRoutes } = await import('./spaces.js');
  const { channelRoutes } = await import('./channels.js');
  app = Fastify();
  await app.register(spaceRoutes);
  await app.register(channelRoutes);
});

function memberRoleIds(userId: string): string[] {
  return testDb.select().from(schema.memberRoles)
    .where(and(eq(schema.memberRoles.spaceId, SPACE_ID), eq(schema.memberRoles.userId, userId)))
    .all().map(r => r.roleId).sort();
}

function expectCode(res: { statusCode: number; json: <T>() => T }, status: number, code: string): void {
  expect(res.statusCode).toBe(status);
  expect(res.json<{ code: string }>().code).toBe(code);
}

describe('PATCH /members/:uid validates roleIds', () => {
  it('refuses the same role id twice with 400, not 500', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/members/member`, payload: { roleIds: ['r-member', 'r-member'] },
    });
    expectCode(res, 400, 'role_ids_invalid');
    expect(memberRoleIds('member')).toEqual([]);
  });

  it('refuses entries that are not strings', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/members/member`, payload: { roleIds: ['r-member', 7] },
    });
    expectCode(res, 400, 'role_ids_invalid');
  });

  it('accepts a list of distinct role ids and tells the space', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/spaces/${SPACE_ID}/members/member`, payload: { roleIds: ['r-member', 'r-mod'] },
    });
    expect(res.statusCode).toBe(200);
    expect(memberRoleIds('member')).toEqual(['r-member', 'r-mod']);
    expect(sendToSpace).toHaveBeenCalledWith(SPACE_ID, { type: 'space_access_changed', spaceId: SPACE_ID });
  });
});

// Each wrapped in its own array so it.each passes arrays and null through as one value.
const BAD_BITS: readonly [unknown][] = (['-1', '-8', '0x10', ' 8', '08', '+8', '1e3', '8.0', '', 8, true, [], ['8'], null] as unknown[]).map((v) => [v]);

describe.each([
  ['channel', `/api/channels/${CHANNEL_ID}/overrides`],
  ['category', `/api/categories/${CATEGORY_ID}/overrides`],
])('PUT %s overrides validates allow and deny', (_kind, url) => {
  it.each(BAD_BITS)('refuses allow %j with override_bits_invalid', async (allow) => {
    const res = await app.inject({ method: 'PUT', url, payload: { targetType: 'role', targetId: 'r-member', allow, deny: '0' } });
    expectCode(res, 400, 'override_bits_invalid');
  });

  it.each(BAD_BITS)('refuses deny %j with override_bits_invalid', async (deny) => {
    const res = await app.inject({ method: 'PUT', url, payload: { targetType: 'role', targetId: 'r-member', allow: '0', deny } });
    expectCode(res, 400, 'override_bits_invalid');
  });

  it('stores canonical strings and treats a missing field as no bits', async () => {
    const send = permissionsToString(PermissionBits.SEND_MESSAGES);
    const res = await app.inject({ method: 'PUT', url, payload: { targetType: 'role', targetId: 'r-member', deny: send } });
    expect(res.statusCode).toBe(200);
    const table = url.startsWith('/api/channels') ? schema.channelOverrides : schema.categoryOverrides;
    const rows = testDb.select().from(table).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.allow).toBe('0');
    expect(rows[0]!.deny).toBe(send);
  });
});

describe('role routes validate permissions', () => {
  it.each(['-1', '0x10', ' 8', '08', 8, true])('POST refuses %j with permissions_invalid', async (permissions) => {
    const res = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/roles`, payload: { name: 'New', permissions } });
    expectCode(res, 400, 'permissions_invalid');
  });

  it.each(['-1', '0x10', ' 8', '08', 8, true])('PATCH refuses %j with permissions_invalid', async (permissions) => {
    const res = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/r-member`, payload: { permissions } });
    expectCode(res, 400, 'permissions_invalid');
  });

  it('create, update and delete each tell the space with space_access_changed', async () => {
    const created = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/roles`, payload: { name: 'New', permissions: '0' } });
    expect(created.statusCode).toBe(201);
    const roleId = created.json<{ id: string }>().id;
    const updated = await app.inject({ method: 'PATCH', url: `/api/spaces/${SPACE_ID}/roles/${roleId}`, payload: { name: 'Renamed' } });
    expect(updated.statusCode).toBe(200);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/roles/${roleId}` });
    expect(deleted.statusCode).toBe(200);
    expect(sendToSpace).toHaveBeenCalledTimes(3);
    for (const call of sendToSpace.mock.calls) {
      expect(call).toEqual([SPACE_ID, { type: 'space_access_changed', spaceId: SPACE_ID }]);
    }
  });

  it('the single-role routes tell the space too', async () => {
    const added = await app.inject({ method: 'POST', url: `/api/spaces/${SPACE_ID}/members/member/roles`, payload: { roleId: 'r-member' } });
    expect(added.statusCode).toBe(200);
    const removed = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/members/member/roles/r-member` });
    expect(removed.statusCode).toBe(200);
    expect(sendToSpace).toHaveBeenCalledTimes(2);
    expect(sendToSpace).toHaveBeenLastCalledWith(SPACE_ID, { type: 'space_access_changed', spaceId: SPACE_ID });
  });
});
