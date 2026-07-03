import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// The userId set onto request by the mocked authenticate preHandler. Tests
// override this per-case to simulate different authenticated users.
let currentUserId = 'alice';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../config.js', () => ({
  config: {
    domain: 'local.example',
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret-12345678901234567890123456789012',
    maxUploadSize: 100 * 1024 * 1024,
    registrationOpen: true,
  },
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
  requireAdmin: async () => {},
}));

vi.mock('../utils/federationAuth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationAuth.js')>('../utils/federationAuth.js');
  return {
    ...actual,
    getOurOrigin: () => 'https://local.example',
    generateHmacSecret: () => 'mock-generated-secret',
  };
});

const sentToUser = vi.fn();
const sentToAdmins = vi.fn();

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: sentToAdmins,
    getAllOnlineUserIds: () => [],
    sendToUser: sentToUser,
    sendToDmMembers: vi.fn(),
  },
}));

vi.mock('../utils/federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(async () => undefined),
  onPeerDeactivated: vi.fn(async () => undefined),
}));

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

function seedInstanceSettings(): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceName: 'Local Backspace',
    autoAcceptPeering: 0,
    registrationOpen: 1,
    updatedAt: Date.now(),
  }).run();
}

function seedUser(id: string, username: string): void {
  testDb.insert(schema.users).values({
    id,
    username,
    passwordHash: 'x',
    displayName: username,
    createdAt: Date.now(),
  }).run();
}

interface SeedSub {
  id: string;
  userId: string;
  reason: 'friend_add' | 'space_join' | 'direct_message';
  target: string;
  createdAt: number;
}

function seedOutboundRequest(opts: {
  id: string;
  origin: string;
  instanceName?: string | null;
  subscribers: SeedSub[];
}): void {
  const now = Date.now();
  testDb.insert(schema.peerApprovalRequests).values({
    id: opts.id,
    origin: opts.origin,
    direction: 'outbound',
    instanceName: opts.instanceName ?? null,
    hmacSecret: null,
    requestedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    approvalToken: null,
  }).run();
  for (const sub of opts.subscribers) {
    testDb.insert(schema.peerApprovalSubscribers).values({
      id: sub.id,
      requestId: opts.id,
      userId: sub.userId,
      triggerReason: sub.reason,
      triggerTarget: sub.target,
      createdAt: sub.createdAt,
    }).run();
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('./federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

describe('GET /api/federation/peering-subscriptions', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    seedUser('alice', 'alice');
    seedUser('bob', 'bob');
    sentToUser.mockClear();
    sentToAdmins.mockClear();
    currentUserId = 'alice';
    app = await buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  // Test 18: GET own subscriptions → returns user rows joined to parent,
  // ordered DESC by createdAt, scoped to the requesting user only.
  it("returns the user's subscriber rows joined to parent requests, ordered DESC by createdAt, scoped to the user", async () => {
    const t0 = 1_700_000_000_000;
    seedOutboundRequest({
      id: 'req-A',
      origin: 'https://orbit.example',
      instanceName: 'Orbit',
      subscribers: [
        { id: 'sub-A-alice-old', userId: 'alice', reason: 'friend_add', target: 'someone@orbit.example', createdAt: t0 },
        { id: 'sub-A-bob', userId: 'bob', reason: 'space_join', target: 'invite-xyz', createdAt: t0 + 100 },
      ],
    });
    seedOutboundRequest({
      id: 'req-B',
      origin: 'https://other.example',
      instanceName: null,
      subscribers: [
        { id: 'sub-B-alice-new', userId: 'alice', reason: 'direct_message', target: 'pal@other.example', createdAt: t0 + 1_000 },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/federation/peering-subscriptions',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      subscriptions: Array<{
        id: string;
        requestId: string;
        peerOrigin: string;
        peerInstanceName: string | null;
        triggerReason: string;
        triggerTarget: string;
        createdAt: number;
      }>;
    };

    // Only alice's two subscriptions returned (bob's not included).
    expect(body.subscriptions).toHaveLength(2);
    expect(body.subscriptions.map(s => s.id)).toEqual(['sub-B-alice-new', 'sub-A-alice-old']);

    // DESC-by-createdAt ordering (newest first).
    const newest = body.subscriptions[0]!;
    const older = body.subscriptions[1]!;
    expect(newest.createdAt).toBe(t0 + 1_000);
    expect(older.createdAt).toBe(t0);

    // Shape: every documented field is present and joined correctly.
    expect(newest).toEqual({
      id: 'sub-B-alice-new',
      requestId: 'req-B',
      peerOrigin: 'https://other.example',
      peerInstanceName: null,
      triggerReason: 'direct_message',
      triggerTarget: 'pal@other.example',
      createdAt: t0 + 1_000,
    });

    expect(older).toEqual({
      id: 'sub-A-alice-old',
      requestId: 'req-A',
      peerOrigin: 'https://orbit.example',
      peerInstanceName: 'Orbit',
      triggerReason: 'friend_add',
      triggerTarget: 'someone@orbit.example',
      createdAt: t0,
    });
  });

  it('returns an empty array when the user has no subscriptions', async () => {
    seedOutboundRequest({
      id: 'req-only-bob',
      origin: 'https://x.example',
      subscribers: [
        { id: 'sub-only-bob', userId: 'bob', reason: 'friend_add', target: 'b@x.example', createdAt: Date.now() },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/federation/peering-subscriptions',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { subscriptions: unknown[] };
    expect(body.subscriptions).toEqual([]);
  });
});

describe('DELETE /api/federation/peering-subscriptions/:id', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    seedUser('alice', 'alice');
    seedUser('bob', 'bob');
    sentToUser.mockClear();
    sentToAdmins.mockClear();
    currentUserId = 'alice';
    app = await buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  // Test 19a: cascade-on-last — alice cancels the SOLE subscriber → parent
  // is cascade-deleted; admin gets federation_peers_changed; user gets
  // peering_subscription_changed.
  it('cascade-deletes parent when the canceller was the last subscriber; fires both WS events', async () => {
    seedOutboundRequest({
      id: 'req-solo',
      origin: 'https://solo.example',
      subscribers: [
        { id: 'sub-solo-alice', userId: 'alice', reason: 'friend_add', target: 'x@solo.example', createdAt: Date.now() },
      ],
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/federation/peering-subscriptions/sub-solo-alice',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    // Subscriber row removed.
    expect(testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.id, 'sub-solo-alice')).get()).toBeUndefined();

    // Parent cascade-deleted.
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-solo')).get()).toBeUndefined();

    // Admin queue refresh broadcast.
    const adminEvents = sentToAdmins.mock.calls.filter(c => {
      const ev = c[0] as { type?: string };
      return ev?.type === 'federation_peers_changed';
    });
    expect(adminEvents).toHaveLength(1);

    // User-facing list refresh broadcast.
    const userEvents = sentToUser.mock.calls.filter(c => {
      const uid = c[0] as string;
      const ev = c[1] as { type?: string };
      return uid === 'alice' && ev?.type === 'peering_subscription_changed';
    });
    expect(userEvents).toHaveLength(1);

    // No notification written for the canceller.
    expect(testDb.select().from(schema.peerApprovalNotifications).all()).toHaveLength(0);
  });

  // Test 19b: no-cascade-when-others-remain — alice cancels her row but bob
  // still subscribes → parent stays; admin event NOT fired; user event fired.
  it('does NOT cascade-delete parent when other subscribers remain; only fires user WS event', async () => {
    seedOutboundRequest({
      id: 'req-shared',
      origin: 'https://shared.example',
      instanceName: 'Shared',
      subscribers: [
        { id: 'sub-shared-alice', userId: 'alice', reason: 'friend_add', target: 'a@shared.example', createdAt: Date.now() },
        { id: 'sub-shared-bob', userId: 'bob', reason: 'space_join', target: 'invite-yz', createdAt: Date.now() },
      ],
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/federation/peering-subscriptions/sub-shared-alice',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    // Alice's row removed.
    expect(testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.id, 'sub-shared-alice')).get()).toBeUndefined();

    // Bob's row still present.
    expect(testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.id, 'sub-shared-bob')).get()).toBeDefined();

    // Parent NOT deleted.
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-shared')).get()).toBeDefined();

    // Admin event NOT fired (queue did not change).
    const adminEvents = sentToAdmins.mock.calls.filter(c => {
      const ev = c[0] as { type?: string };
      return ev?.type === 'federation_peers_changed';
    });
    expect(adminEvents).toHaveLength(0);

    // User event still fired.
    const userEvents = sentToUser.mock.calls.filter(c => {
      const uid = c[0] as string;
      const ev = c[1] as { type?: string };
      return uid === 'alice' && ev?.type === 'peering_subscription_changed';
    });
    expect(userEvents).toHaveLength(1);

    // No notification written.
    expect(testDb.select().from(schema.peerApprovalNotifications).all()).toHaveLength(0);
  });

  // Test 20: foreign-user delete → 403, no DB mutation, no broadcasts.
  it('returns 403 when the row belongs to another user; no DB mutation; no WS broadcasts', async () => {
    seedOutboundRequest({
      id: 'req-foreign',
      origin: 'https://foreign.example',
      subscribers: [
        { id: 'sub-foreign-bob', userId: 'bob', reason: 'friend_add', target: 'b@foreign.example', createdAt: Date.now() },
      ],
    });

    // currentUserId is alice, but the row is bob's.
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/federation/peering-subscriptions/sub-foreign-bob',
    });

    expect(response.statusCode).toBe(403);
    const body = response.json() as { error: string };
    expect(body.error).toBe('forbidden');

    // Row UNTOUCHED.
    expect(testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.id, 'sub-foreign-bob')).get()).toBeDefined();

    // Parent UNTOUCHED.
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-foreign')).get()).toBeDefined();

    // No broadcasts.
    expect(sentToAdmins).not.toHaveBeenCalled();
    expect(sentToUser).not.toHaveBeenCalled();
  });

  // Test 21: nonexistent row → 404.
  it('returns 404 when the subscription id does not exist', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/federation/peering-subscriptions/sub-does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json() as { error: string };
    expect(body.error).toBe('subscription_not_found');

    // No broadcasts.
    expect(sentToAdmins).not.toHaveBeenCalled();
    expect(sentToUser).not.toHaveBeenCalled();
  });
});
