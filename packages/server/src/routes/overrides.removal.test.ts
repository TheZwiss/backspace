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

// Removing a role override (#290): the DELETE routes drop the override row so
// the role falls back to its space-wide permissions, and deleting the role
// itself leaves no override behind on channels or categories.

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

const sendToUser = vi.fn();
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    addUserSpace: vi.fn(),
    sendToSpace: vi.fn(),
    sendToUser: (...args: unknown[]) => sendToUser(...args),
    pushReadyPayload: vi.fn(),
    getUserSpaceEntries: () => new Map([['owner', new Set(['space-1'])], ['member', new Set(['space-1'])]]).entries(),
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
const ROLE_ID = 'role-mod';
const now = 1_700_000_000_000;

let app: FastifyInstance;

function channelOverrideRows() {
  return testDb.select().from(schema.channelOverrides)
    .where(and(eq(schema.channelOverrides.targetType, 'role'), eq(schema.channelOverrides.targetId, ROLE_ID)))
    .all();
}

function categoryOverrideRows() {
  return testDb.select().from(schema.categoryOverrides)
    .where(and(eq(schema.categoryOverrides.targetType, 'role'), eq(schema.categoryOverrides.targetId, ROLE_ID)))
    .all();
}

beforeEach(async () => {
  sendToUser.mockClear();
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
    { id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', position: 0, permissions: permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES), createdAt: now },
    { id: ROLE_ID, spaceId: SPACE_ID, name: 'Moderators', position: 1, permissions: '0', createdAt: now },
  ]).run();
  testDb.insert(schema.memberRoles).values({ spaceId: SPACE_ID, userId: 'member', roleId: ROLE_ID }).run();
  testDb.insert(schema.channelCategories).values({ id: CATEGORY_ID, spaceId: SPACE_ID, name: 'cat', position: 0, createdAt: now }).run();
  testDb.insert(schema.channels).values({ id: CHANNEL_ID, spaceId: SPACE_ID, name: 'general', type: 'text', position: 0, categoryId: CATEGORY_ID, createdAt: now }).run();

  // The role is denied SEND_MESSAGES in the channel and in its category.
  const deny = permissionsToString(PermissionBits.SEND_MESSAGES);
  testDb.insert(schema.channelOverrides).values({ channelId: CHANNEL_ID, targetType: 'role', targetId: ROLE_ID, allow: '0', deny }).run();
  testDb.insert(schema.categoryOverrides).values({ categoryId: CATEGORY_ID, targetType: 'role', targetId: ROLE_ID, allow: '0', deny }).run();

  const { spaceRoutes } = await import('./spaces.js');
  const { channelRoutes } = await import('./channels.js');
  app = Fastify();
  await app.register(spaceRoutes);
  await app.register(channelRoutes);
});

describe('removing a role override', () => {
  it('DELETE on a channel override drops the row and the role falls back to its space-wide permissions', async () => {
    const { computePermissions } = await import('../utils/permissions.js');
    testDb.delete(schema.categoryOverrides).run();
    expect(computePermissions('member', SPACE_ID, CHANNEL_ID) & PermissionBits.SEND_MESSAGES).toBe(0n);

    const res = await app.inject({ method: 'DELETE', url: `/api/channels/${CHANNEL_ID}/overrides/role/${ROLE_ID}` });

    expect(res.statusCode).toBe(200);
    expect(channelOverrideRows()).toHaveLength(0);
    expect(computePermissions('member', SPACE_ID, CHANNEL_ID) & PermissionBits.SEND_MESSAGES).toBe(PermissionBits.SEND_MESSAGES);
    // Every connected member is told about the channel again, with the
    // permissions they now hold in it.
    expect(sendToUser).toHaveBeenCalledWith('member', expect.objectContaining({ type: 'channel_updated', spaceId: SPACE_ID }));
  });

  it('DELETE on a category override drops the row', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/categories/${CATEGORY_ID}/overrides/role/${ROLE_ID}` });
    expect(res.statusCode).toBe(200);
    expect(categoryOverrideRows()).toHaveLength(0);
  });

  it('refuses without MANAGE_ROLES', async () => {
    currentUserId = 'member';
    const res = await app.inject({ method: 'DELETE', url: `/api/channels/${CHANNEL_ID}/overrides/role/${ROLE_ID}` });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('missing_permission');
    expect(channelOverrideRows()).toHaveLength(1);
  });

  it('deleting the role removes its overrides on channels and on categories', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/spaces/${SPACE_ID}/roles/${ROLE_ID}` });
    expect(res.statusCode).toBe(200);
    expect(channelOverrideRows()).toHaveLength(0);
    expect(categoryOverrideRows()).toHaveLength(0);
  });

  it('does not touch another space\'s overrides through a role id that is not in this space', async () => {
    testDb.insert(schema.spaces).values({
      id: 'space-2', name: 'Other', ownerId: 'owner', inviteCode: 'code-2', visibility: 'public', createdAt: now,
    }).run();
    const res = await app.inject({ method: 'DELETE', url: `/api/spaces/space-2/roles/${ROLE_ID}` });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('role_not_in_space');
    expect(channelOverrideRows()).toHaveLength(1);
    expect(categoryOverrideRows()).toHaveLength(1);
  });
});
