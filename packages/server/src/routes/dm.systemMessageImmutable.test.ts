import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level mutable state. The vi.mock factories below close over these
// bindings via getter functions, so reassignment in beforeEach is observed.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'alice';

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
    queueOutboxEvent: vi.fn(),
    appendMutationLog: vi.fn(),
  };
});

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://local.test' };
});

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sqlText.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

interface UserSeed {
  id: string;
  username: string;
  displayName?: string | null;
}

function seedUser(u: UserSeed): void {
  testDb.insert(schema.users).values({
    id: u.id,
    username: u.username,
    displayName: u.displayName ?? null,
    passwordHash: 'x',
    status: 'offline',
    isAdmin: 0,
    isDeleted: 0,
    discoverable: 1,
    homeInstance: null,
    homeUserId: null,
    createdAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { dmRoutes } = await import('./dm.js');
  await app.register(dmRoutes);
  await app.ready();
  return app;
}

describe('PATCH /api/dm/messages/:id on a system message', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedUser({ id: 'alice', username: 'alice' });
    seedUser({ id: 'bob', username: 'bob' });
    currentUserId = 'alice';
    app = await buildApp();
  });

  it('refuses an edit of a system message, even by its author', async () => {
    const now = Date.now();
    testDb.insert(schema.dmChannels).values({ id: 'dm1', ownerId: null, federatedId: null, createdAt: now }).run();
    testDb.insert(schema.dmMembers).values([{ dmChannelId: 'dm1', userId: 'alice', closed: 0 }, { dmChannelId: 'dm1', userId: 'bob', closed: 0 }]).run();
    const invite = JSON.stringify({ event: 'space_invite', spaceId: 'S1', spaceInstanceOrigin: 'https://local.test', inviteCode: 'abc', snapshot: { spaceName: 'Real', icon: null, avatarColor: null, memberCount: 2, description: null, instanceName: 'local' } });
    testDb.insert(schema.dmMessages).values({ id: 'm1', dmChannelId: 'dm1', userId: 'alice', content: invite, type: 'system', createdAt: now }).run();

    const replacement = JSON.stringify({ event: 'owner_changed', newOwnerId: 'alice', newOwnerDisplayName: 'Alice' });
    const res = await app.inject({ method: 'PATCH', url: '/api/dm/messages/m1', payload: { content: replacement } });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('system_message_immutable');
    const row = testDb.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, 'm1')).get();
    expect(row?.content).toBe(invite);
    expect(row?.editedAt).toBeNull();
  });
});
