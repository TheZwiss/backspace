import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_MESSAGE_LENGTH } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'owner-A';

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
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    getRoom: () => undefined,
    getUserRoom: () => undefined,
    leaveCurrentRoom: vi.fn(() => false),
    destroyRoom: vi.fn(),
    clearVoiceUserStatus: vi.fn(),
  },
}));

vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    isFederationRelayEnabled: () => false,
    queueDmCloseRelay: vi.fn(),
    sendTypingRelay: vi.fn(),
    queueDmRelay: vi.fn(),
    queueGroupMetadataRelay: vi.fn(),
  };
});

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://local.test' };
});

vi.mock('../utils/fileCleanup.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fileCleanup.js')>('../utils/fileCleanup.js');
  return {
    ...actual,
    deleteUploadFile: vi.fn(),
    deleteAttachmentByFilename: vi.fn(),
    deleteAttachmentFiles: vi.fn(),
  };
});

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(id: string, username: string): void {
  testDb.insert(schema.users).values({
    id,
    username,
    displayName: username,
    passwordHash: 'x',
    homeUserId: id,
    homeInstance: 'https://local.test',
    createdAt: Date.now(),
  }).run();
}

function seedGroupDm(id: string, ownerId: string, members: string[]): void {
  testDb.insert(schema.dmChannels).values({ id, ownerId, federatedId: null, createdAt: Date.now() }).run();
  for (const userId of members) {
    testDb.insert(schema.dmMembers).values({ dmChannelId: id, userId }).run();
  }
}

function seed1on1Dm(id: string, a: string, b: string): void {
  testDb.insert(schema.dmChannels).values({ id, ownerId: null, createdAt: Date.now() }).run();
  testDb.insert(schema.dmMembers).values({ dmChannelId: id, userId: a }).run();
  testDb.insert(schema.dmMembers).values({ dmChannelId: id, userId: b }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { dmRoutes } = await import('./dm.js');
  await app.register(dmRoutes);
  await app.ready();
  return app;
}

describe('DM routes send stable error codes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedUser('owner-A', 'alice');
    seedUser('member-B', 'bob');
    seedUser('outsider-C', 'carol');
    seedGroupDm('group-1', 'owner-A', ['owner-A', 'member-B']);
    seed1on1Dm('dm-1', 'owner-A', 'member-B');
    currentUserId = 'owner-A';
    app = await buildApp();
  });

  it('creating a DM with an unknown user answers user_not_found', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dm', payload: { userId: 'nobody' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'user_not_found', error: 'User not found', statusCode: 404 });
  });

  it('creating a DM with yourself answers cannot_dm_self', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dm', payload: { userId: 'owner-A' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('cannot_dm_self');
  });

  it('a group over the member limit answers group_dm_too_many_members with the limit', async () => {
    const users = Array.from({ length: 10 }, (_, i) => ({ id: `u-${i}` }));
    const res = await app.inject({ method: 'POST', url: '/api/dm/group', payload: { users } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('group_dm_too_many_members');
    expect(res.json().details).toEqual({ max: 10, requested: 11 });
  });

  it('updating an unknown DM answers dm_not_found', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/dm/missing', payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('dm_not_found');
  });

  it('updating a group you are not in answers not_dm_member', async () => {
    currentUserId = 'outsider-C';
    const res = await app.inject({ method: 'PATCH', url: '/api/dm/group-1', payload: { name: 'x' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_dm_member');
  });

  it('updating a group as a plain member answers dm_owner_only', async () => {
    currentUserId = 'member-B';
    const res = await app.inject({ method: 'PATCH', url: '/api/dm/group-1', payload: { name: 'x' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('dm_owner_only');
  });

  it('updating a 1-on-1 DM answers dm_not_group and still names the 1-on-1', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/dm/dm-1', payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('dm_not_group');
    expect(res.json().error).toMatch(/1-on-1/);
  });

  it('a too-long group name answers group_dm_name_length with the bounds', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/dm/group-1', payload: { name: 'x'.repeat(51) } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('group_dm_name_length');
    expect(res.json().details).toEqual({ min: 1, max: 50 });
    expect(res.json().error).toBe('Group DM name must be between 1 and 50 characters');
  });

  it('a too-long message answers content_too_long with the limit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-1/messages',
      payload: { content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('content_too_long');
    expect(res.json().details).toEqual({ max: MAX_MESSAGE_LENGTH });
  });

  it('an empty message answers content_required', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dm/dm-1/messages', payload: { content: '   ' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('content_required');
  });

  it('editing an unknown message answers message_not_found', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/dm/messages/missing', payload: { content: 'hi' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('message_not_found');
  });

  it('leaving a 1-on-1 DM answers dm_not_group', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/dm/dm-1/members' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('dm_not_group');
  });

  it('kicking yourself as owner answers owner_cannot_kick_self', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/dm/group-1/members/owner-A' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('owner_cannot_kick_self');
  });

  it('transferring to the current owner answers already_owner', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dm/group-1/transfer', payload: { newOwnerId: 'owner-A' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('already_owner');
  });
});
