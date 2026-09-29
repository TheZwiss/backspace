import { MAX_OWNER_TITLE_LENGTH } from '@backspace/shared/src/constants.js';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
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
vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({ authenticate: async (req: { userId?: string }) => { req.userId = currentUserId; } }));
vi.mock('../ws/handler.js', () => ({ connectionManager: { sendToSpace: (...args: unknown[]) => sendToSpace(...args) } }));

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  testDb = drizzle(sqlite, { schema });
  currentUserId = 'owner';
  sendToSpace.mockClear();
  for (const id of ['owner', 'manager', 'member', 'outsider']) {
    testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: 1 }).run();
  }
  for (const id of ['space', 'other-space']) {
    testDb.insert(schema.spaces).values({ id, name: id, ownerId: 'owner', createdAt: 1 }).run();
    for (const userId of ['owner', 'manager', 'member']) {
      testDb.insert(schema.spaceMembers).values({ spaceId: id, userId, joinedAt: 1 }).run();
    }
  }
  testDb.insert(schema.roles).values({ id: 'manager-role', spaceId: 'space', name: 'Manager', permissions: PermissionBits.MANAGE_SPACE.toString(), position: 1, createdAt: 1 }).run();
  testDb.insert(schema.memberRoles).values({ spaceId: 'space', userId: 'manager', roleId: 'manager-role' }).run();
  const { spaceRoutes } = await import('./spaces.js');
  app = Fastify();
  await app.register(spaceRoutes);
});

afterEach(async () => {
  await app.close();
  sqlite.close();
});

const update = (ownerTitle: unknown) => app.inject({ method: 'PATCH', url: '/api/spaces/space', payload: { ownerTitle } });
const stored = () => testDb.select().from(schema.spaces).where(eq(schema.spaces.id, 'space')).get()!;

describe('space owner title', () => {
  it('stores the trimmed title, broadcasts it, and exposes it to other members after a new request', async () => {
    const response = await update('  首席摸鱼官  ');
    expect(response.statusCode).toBe(200);
    expect(response.json().ownerTitle).toBe('首席摸鱼官');
    expect(stored().ownerTitle).toBe('首席摸鱼官');
    expect(sendToSpace).toHaveBeenCalledWith('space', { type: 'space_updated', space: expect.objectContaining({ ownerId: 'owner', ownerTitle: '首席摸鱼官' }) });
    currentUserId = 'member';
    expect((await app.inject('/api/spaces/space')).json().ownerTitle).toBe('首席摸鱼官');
    expect((await app.inject('/api/spaces')).json().find((s: { id: string }) => s.id === 'space').ownerTitle).toBe('首席摸鱼官');
    expect((await app.inject('/api/spaces/other-space')).json().ownerTitle).toBeNull();
  });

  it.each(['manager', 'member', 'outsider'])('rejects %s even if they can manage the space', async (userId) => {
    currentUserId = userId;
    const response = await update('Not the owner');
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('space_owner_only');
    expect(stored().ownerTitle).toBeNull();
    expect(sendToSpace).not.toHaveBeenCalled();
  });

  it('rejects a mixed unauthorized patch atomically', async () => {
    currentUserId = 'manager';
    const response = await app.inject({ method: 'PATCH', url: '/api/spaces/space', payload: { name: 'Renamed', ownerTitle: 'Boss' } });
    expect(response.statusCode).toBe(403);
    expect(stored().name).toBe('space');
    // MANAGE_SPACE itself is unchanged when no owner title is requested.
    expect((await app.inject({ method: 'PATCH', url: '/api/spaces/space', payload: { name: 'Renamed' } })).statusCode).toBe(200);
  });

  it.each(['', '   ', '\n', 'Boss\nOwner', 123, false, {}, [], 'x'.repeat(MAX_OWNER_TITLE_LENGTH + 1)])('rejects invalid title %j without persisting or broadcasting', async (title) => {
    const response = await update(title);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('space_owner_title_invalid');
    expect(stored().ownerTitle).toBeNull();
    expect(sendToSpace).not.toHaveBeenCalled();
  });

  it('accepts the exact length limit and resets only through explicit null', async () => {
    expect((await update('字'.repeat(MAX_OWNER_TITLE_LENGTH))).statusCode).toBe(200);
    const response = await update(null);
    expect(response.statusCode).toBe(200);
    expect(response.json().ownerTitle).toBeNull();
    expect(stored().ownerTitle).toBeNull();
  });

  it('does not let a new owner inherit the old owner’s personal title', async () => {
    await update('Old captain');
    const response = await app.inject({ method: 'PATCH', url: '/api/spaces/space/transfer-ownership', payload: { newOwnerId: 'member' } });
    expect(response.statusCode).toBe(200);
    expect(stored()).toMatchObject({ ownerId: 'member', ownerTitle: null });
    expect((await update('Old owner')).statusCode).toBe(403);
    currentUserId = 'member';
    expect((await update('New captain')).statusCode).toBe(200);
  });

  it('reports an unknown space', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/api/spaces/missing', payload: { ownerTitle: 'Boss' } });
    expect(response.statusCode).toBe(404);
  });
});
