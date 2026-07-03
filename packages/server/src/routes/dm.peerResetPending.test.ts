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

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
const currentUserId = 'user-A';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
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
    isFederationRelayEnabled: () => true,
    queueDmCloseRelay: vi.fn(),
    sendTypingRelay: vi.fn(),
    queueDmRelay: vi.fn(),
    queueOutboxEvent: vi.fn(),
    appendMutationLog: vi.fn(),
  };
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

function seedCaller(): void {
  testDb.insert(schema.users).values({
    id: 'user-A',
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'x',
    homeUserId: 'user-A',
    homeInstance: null,
    createdAt: Date.now(),
  }).run();
}

/** The reset peer's persistent row (still present during the limbo window — only
 *  deleted on admin Re-peer). Its `origin` is the exact string markPeerReset journals. */
function seedPeer(): void {
  testDb.insert(schema.federationPeers).values({
    id: 'peer-remote',
    origin: 'https://remote.example',
    hmacSecret: 'secret',
    status: 'needs_attention',
    needsAttentionReason: 'peer_reset_detected',
    peerInstanceId: 'dead-epoch',
    observedPeerInstanceId: 'new-epoch',
    createdAt: Date.now(),
  }).run();
}

function seedResetEvent(resolvedAt: number | null): void {
  testDb.insert(schema.federationResetEvents).values({
    origin: 'https://remote.example',
    deadEpoch: 'dead-epoch',
    newEpoch: resolvedAt === null ? null : 'new-epoch',
    detectedAt: Date.now(),
    resolvedAt,
    stubCount: 1,
    orphanedAccountCount: 0,
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { dmRoutes } = await import('./dm.js');
  await app.register(dmRoutes);
  await app.ready();
  return app;
}

describe('POST /api/dm — limbo-window peer_reset_pending guard', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedCaller();
    seedPeer();
  });

  it('returns 409 peer_reset_pending when creating a federated DM to a reset-pending origin', async () => {
    seedResetEvent(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dm',
      payload: { homeUserId: 'remote-bob', homeInstance: 'https://remote.example' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('peer_reset_pending');
    // No stub created and no DM channel created for the reset-pending peer.
    expect(testDb.select().from(schema.dmChannels).all()).toHaveLength(0);
    expect(testDb.select().from(schema.users).where(eq(schema.users.homeUserId, 'remote-bob')).all()).toHaveLength(0);
  });

  it('proceeds normally when the reset event is RESOLVED', async () => {
    seedResetEvent(Date.now());

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dm',
      payload: { homeUserId: 'remote-bob', homeInstance: 'https://remote.example' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().federatedId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('proceeds normally when NO reset event exists for the origin', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/dm',
      payload: { homeUserId: 'remote-bob', homeInstance: 'https://remote.example' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().federatedId).toMatch(/^[a-f0-9]{32}$/);
  });
});
