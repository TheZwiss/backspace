import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'admin-user';
let currentUserIsAdmin = true;

// Mock getDb BEFORE importing the route module so the module reads our test DB.
// Must also re-export `schema` because federation.ts imports it from '../db/index.js'.
vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

// Mock the auth middleware to honour test-controlled currentUserId / currentUserIsAdmin.
vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    if (!currentUserId) {
      throw Object.assign(new Error('unauthenticated'), { statusCode: 401 });
    }
    req.userId = currentUserId;
  },
  requireAdmin: async (req: { userId?: string }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!currentUserIsAdmin) {
      return reply.code(403).send({ error: 'Only instance admins can perform this action', statusCode: 403 });
    }
  },
}));

// Mock the WS connection manager — the handler only calls sendToAdmins.
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
  },
}));

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Import the route module AFTER the mocks above are set up.
  const { federationRoutes } = await import('./federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    // drizzle-kit uses `--> statement-breakpoint` as separator
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

describe('POST /api/federation/peers/:id/reset', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    testDb = drizzle(sqlite, { schema });
    currentUserId = 'admin-user';
    currentUserIsAdmin = true;
    app = await buildApp();
  });

  it('returns 404 when the peer does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/federation/peers/nonexistent/reset',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Peer not found' });
  });

  it('returns 400 when the peer status is not needs_attention', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-1',
      origin: 'https://example.com',
      hmacSecret: 'a'.repeat(64),
      status: 'active',
      createdAt: Date.now(),
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/federation/peers/peer-1/reset',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('needs_attention');

    // Verify the peer row was NOT deleted
    const still = testDb.select().from(schema.federationPeers).all();
    expect(still).toHaveLength(1);
  });

  it('returns 403 when the caller is not an admin', async () => {
    currentUserIsAdmin = false;
    testDb.insert(schema.federationPeers).values({
      id: 'peer-1',
      origin: 'https://example.com',
      hmacSecret: 'a'.repeat(64),
      status: 'needs_attention',
      createdAt: Date.now(),
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/federation/peers/peer-1/reset',
    });
    expect(res.statusCode).toBe(403);

    // Row must still exist
    const still = testDb.select().from(schema.federationPeers).all();
    expect(still).toHaveLength(1);
  });

  it('deletes the peer and cascade-removes outbox entries on success', async () => {
    const now = Date.now();
    testDb.insert(schema.federationPeers).values({
      id: 'peer-1',
      origin: 'https://example.com',
      hmacSecret: 'a'.repeat(64),
      status: 'needs_attention',
      createdAt: now,
    }).run();

    // Queue two outbox entries for this peer
    testDb.insert(schema.federationOutbox).values([
      {
        id: 'out-1',
        peerId: 'peer-1',
        contextId: 'dm-1',
        entityId: 'msg-1',
        contextType: 'dm',
        eventType: 'message_create',
        payload: '{}',
        nextRetryAt: now,
        expiresAt: now + 86_400_000,
        createdAt: now,
      },
      {
        id: 'out-2',
        peerId: 'peer-1',
        contextId: 'dm-1',
        entityId: 'msg-2',
        contextType: 'dm',
        eventType: 'message_create',
        payload: '{}',
        nextRetryAt: now,
        expiresAt: now + 86_400_000,
        createdAt: now,
      },
    ]).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/federation/peers/peer-1/reset',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    // Peer deleted
    const peers = testDb.select().from(schema.federationPeers).all();
    expect(peers).toHaveLength(0);

    // Outbox entries cascade-removed
    const outbox = testDb.select().from(schema.federationOutbox).all();
    expect(outbox).toHaveLength(0);
  });
});
