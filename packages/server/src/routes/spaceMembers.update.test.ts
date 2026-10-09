import { MAX_MEMBER_NICKNAME_LENGTH } from '@backspace/shared/src/constants.js';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema.js';
import { PermissionBits } from '../utils/permissions.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let app: FastifyInstance;
let currentUserId = 'owner';
const sendToSpace = vi.fn();
const announceSpaceAccessChange = vi.fn();
const checkVoicePermissions = vi.fn();
vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({ authenticate: async (req: { userId?: string }) => { req.userId = currentUserId; } }));
vi.mock('../ws/handler.js', () => ({ connectionManager: { sendToSpace: (...args: unknown[]) => sendToSpace(...args), announceSpaceAccessChange: (...args: unknown[]) => announceSpaceAccessChange(...args) } }));

vi.mock('../ws/events.js', () => ({ checkVoicePermissions: (...args: unknown[]) => checkVoicePermissions(...args) }));

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  testDb = drizzle(sqlite, { schema });
  currentUserId = 'owner';
  vi.clearAllMocks();
  for (const id of ['owner', 'manager', 'moderator', 'member', 'outsider']) {
    testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: 1 }).run();
  }
  for (const id of ['space', 'other-space']) {
    testDb.insert(schema.spaces).values({ id, name: id, ownerId: 'owner', createdAt: 1 }).run();
    for (const userId of ['owner', 'manager', 'moderator', 'member']) {
      testDb.insert(schema.spaceMembers).values({ spaceId: id, userId, joinedAt: 1 }).run();
    }
  }
  testDb.insert(schema.roles).values({ id: 'manager-role', spaceId: 'space', name: 'Manager', permissions: PermissionBits.MANAGE_SPACE.toString(), position: 1, createdAt: 1 }).run();
  testDb.insert(schema.memberRoles).values({ spaceId: 'space', userId: 'manager', roleId: 'manager-role' }).run();
  testDb.insert(schema.roles).values([
    { id: 'mod-role', spaceId: 'space', name: 'Moderator', permissions: PermissionBits.MANAGE_ROLES.toString(), position: 2, createdAt: 1 },
    { id: 'space', spaceId: 'space', name: '@everyone', permissions: '0', position: 0, createdAt: 1 },
    { id: 'other-role', spaceId: 'other-space', name: 'Other', permissions: '0', position: 1, createdAt: 1 },
  ]).run();
  testDb.insert(schema.memberRoles).values({ spaceId: 'space', userId: 'moderator', roleId: 'mod-role' }).run();
  const { spaceRoutes } = await import('./spaces.js');
  app = Fastify();
  await app.register(spaceRoutes);
});

afterEach(async () => {
  await app.close();
  sqlite.close();
});

const update = (payload: object, userId = 'member') => app.inject({ method: 'PATCH', url: '/api/spaces/space/members/' + userId, payload });
const stored = (userId = 'member', spaceId = 'space') => testDb.select().from(schema.spaceMembers)
  .where(and(eq(schema.spaceMembers.spaceId, spaceId), eq(schema.spaceMembers.userId, userId))).get()!;

describe('space member nickname and roles', () => {
  it('persists a self nickname, broadcasts it and leaves account/other space untouched', async () => {
    currentUserId = 'member';
    const response = await update({ nickname: '  宇航员  ' });
    expect(response.statusCode).toBe(200);
    expect(stored().nickname).toBe('宇航员');
    expect(stored('member', 'other-space').nickname).toBeNull();
    expect(testDb.select().from(schema.users).where(eq(schema.users.id, 'member')).get()?.displayName).toBeNull();
    currentUserId = 'owner';
    const members = (await app.inject('/api/spaces/space/members')).json();
    expect(members.find((m: { userId: string }) => m.userId === 'member').nickname).toBe('宇航员');
    expect(sendToSpace).toHaveBeenCalledWith('space', { type: 'member_updated', spaceId: 'space', member: response.json() });
    expect(announceSpaceAccessChange).not.toHaveBeenCalled();
    expect(checkVoicePermissions).not.toHaveBeenCalled();
  });

  it.each(['owner', 'manager'])('%s can rename other non-owner members', async actor => {
    currentUserId = actor;
    expect((await update({ nickname: 'Pilot' })).statusCode).toBe(200);
    expect(stored().nickname).toBe('Pilot');
  });

  it('allows owners to rename themselves and restore default explicitly', async () => {
    expect((await update({ nickname: 'Boss' }, 'owner')).statusCode).toBe(200);
    expect((await update({ nickname: null }, 'owner')).statusCode).toBe(200);
    expect(stored('owner').nickname).toBeNull();
  });

  it.each(['member', 'moderator', 'outsider'])('does not let %s rename another member', async actor => {
    currentUserId = actor;
    expect((await update({ nickname: 'No' }, 'manager')).statusCode).toBe(403);
    expect(stored('manager').nickname).toBeNull();
    expect(sendToSpace).not.toHaveBeenCalled();
  });

  it('protects the owner even from MANAGE_SPACE', async () => {
    currentUserId = 'manager';
    expect((await update({ nickname: 'No' }, 'owner')).statusCode).toBe(403);
  });

  it.each(['', '  ', 'a\nb', 'a\rb', 1, false, [], {}, 'x'.repeat(MAX_MEMBER_NICKNAME_LENGTH + 1)])('rejects invalid nickname %j', async nickname => {
    const response = await update({ nickname });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('member_nickname_invalid');
    expect(stored().nickname).toBeNull();
    expect(sendToSpace).not.toHaveBeenCalled();
  });

  it('accepts the nickname limit, and nickname-only updates preserve roles', async () => {
    expect((await update({ roleIds: ['mod-role'] })).statusCode).toBe(200);
    const response = await update({ nickname: 'x'.repeat(MAX_MEMBER_NICKNAME_LENGTH) });
    expect(response.statusCode).toBe(200);
    expect(response.json().roles.map((r: { id: string }) => r.id)).toEqual(['mod-role']);
  });

  it('changes assignments, not role definitions, and refreshes permissions', async () => {
    currentUserId = 'owner';
    const response = await update({ roleIds: ['manager-role'] });
    expect(response.statusCode).toBe(200);
    expect(response.json().roles.map((r: { id: string }) => r.id)).toEqual(['manager-role']);
    expect(announceSpaceAccessChange).toHaveBeenCalledWith('space', ['member']);
    expect(checkVoicePermissions).toHaveBeenCalledWith('space');
    expect(sendToSpace).toHaveBeenCalledWith('space', expect.objectContaining({ type: 'member_updated' }));
    expect(testDb.select().from(schema.roles).where(eq(schema.roles.id, 'manager-role')).get()?.permissions).toBe(PermissionBits.MANAGE_SPACE.toString());
    expect((await update({ roleIds: [] })).json().roles).toEqual([]);
  });

  it.each([null, {}, ['mod-role', 'mod-role'], [1], ['missing'], ['other-role'], ['space']])('rejects invalid assignments %j atomically', async roleIds => {
    const response = await update({ roleIds, nickname: 'Must not save' });
    expect(response.statusCode).toBe(400);
    expect(stored().nickname).toBeNull();
    expect(sendToSpace).not.toHaveBeenCalled();
  });

  it('validates every field before writing a mixed patch', async () => {
    currentUserId = 'moderator';
    expect((await update({ roleIds: ['manager-role'], nickname: 'No' })).statusCode).toBe(403);
    const rows = (await app.inject('/api/spaces/space/members')).json();
    expect(rows.find((m: { userId: string }) => m.userId === 'member').roles).toEqual([]);
    currentUserId = 'member';
    expect((await update({ nickname: 'Self', roleIds: [] })).statusCode).toBe(403);
    expect(stored().nickname).toBeNull();
  });

  it('keeps self/owner role protections and fails for absent members', async () => {
    expect((await update({ roleIds: [] }, 'owner')).statusCode).toBe(400);
    currentUserId = 'moderator';
    expect((await update({ roleIds: [] }, 'owner')).statusCode).toBe(403);
    expect((await update({ roleIds: [] }, 'outsider')).statusCode).toBe(404);
  });
  it.each(['null', '[]', '1', '"invalid"', '{}'])('rejects malformed or empty patches %s without writes', async payload => {
    const response = await app.inject({ method: 'PATCH', url: '/api/spaces/space/members/member',
      headers: { 'content-type': 'application/json' }, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('validation_failed');
    expect(stored().nickname).toBeNull();
    expect(sendToSpace).not.toHaveBeenCalled();
  });

  it('commits nickname and role assignments together, and preserves both on invalid input', async () => {
    const response = await update({ nickname: 'Pilot', roleIds: ['mod-role'] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ nickname: 'Pilot', roles: [{ id: 'mod-role' }] });
    expect((await update({ nickname: 'a\nb', roleIds: [] })).statusCode).toBe(400);
    const members = (await app.inject('/api/spaces/space/members')).json();
    expect(members.find((m: { userId: string }) => m.userId === 'member')).toMatchObject({ nickname: 'Pilot', roles: [{ id: 'mod-role' }] });
  });

});
