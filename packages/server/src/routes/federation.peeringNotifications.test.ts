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

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    sendToUser: vi.fn(),
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

interface SeedNotif {
  id: string;
  userId: string;
  kind: 'approved' | 'denied' | 'expired';
  peerOrigin: string;
  triggerReason: string;
  triggerTarget: string;
  createdAt: number;
  readAt: number | null;
}

function seedNotification(n: SeedNotif): void {
  testDb.insert(schema.peerApprovalNotifications).values({
    id: n.id,
    userId: n.userId,
    kind: n.kind,
    peerOrigin: n.peerOrigin,
    triggerReason: n.triggerReason,
    triggerTarget: n.triggerTarget,
    createdAt: n.createdAt,
    readAt: n.readAt,
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('./federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

describe('GET /api/federation/peering-notifications', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    seedUser('alice', 'alice');
    seedUser('bob', 'bob');
    currentUserId = 'alice';
    app = await buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  // Test 22: GET → user's rows ordered DESC by createdAt.
  it("returns the user's notifications ordered DESC by createdAt", async () => {
    const t0 = 1_700_000_000_000;
    seedNotification({
      id: 'notif-old',
      userId: 'alice',
      kind: 'approved',
      peerOrigin: 'https://orbit.example',
      triggerReason: 'friend_add',
      triggerTarget: 'someone@orbit.example',
      createdAt: t0,
      readAt: null,
    });
    seedNotification({
      id: 'notif-new',
      userId: 'alice',
      kind: 'denied',
      peerOrigin: 'https://other.example',
      triggerReason: 'space_join',
      triggerTarget: 'invite-xyz',
      createdAt: t0 + 1_000,
      readAt: null,
    });
    seedNotification({
      id: 'notif-mid',
      userId: 'alice',
      kind: 'expired',
      peerOrigin: 'https://third.example',
      triggerReason: 'direct_message',
      triggerTarget: 'pal@third.example',
      createdAt: t0 + 500,
      readAt: t0 + 800,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/federation/peering-notifications',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      notifications: Array<{
        id: string;
        kind: string;
        peerOrigin: string;
        triggerReason: string;
        triggerTarget: string;
        createdAt: number;
        readAt: number | null;
      }>;
    };

    expect(body.notifications).toHaveLength(3);
    expect(body.notifications.map(n => n.id)).toEqual(['notif-new', 'notif-mid', 'notif-old']);

    // Shape check on the newest row.
    expect(body.notifications[0]).toEqual({
      id: 'notif-new',
      kind: 'denied',
      peerOrigin: 'https://other.example',
      triggerReason: 'space_join',
      triggerTarget: 'invite-xyz',
      createdAt: t0 + 1_000,
      readAt: null,
    });
  });

  // Test 23: GET ?unread=1 → only readAt IS NULL rows.
  it('filters to only unread notifications when ?unread=1', async () => {
    const t0 = 1_700_000_000_000;
    seedNotification({
      id: 'notif-unread-1',
      userId: 'alice',
      kind: 'approved',
      peerOrigin: 'https://a.example',
      triggerReason: 'friend_add',
      triggerTarget: 'a@a.example',
      createdAt: t0,
      readAt: null,
    });
    seedNotification({
      id: 'notif-read',
      userId: 'alice',
      kind: 'denied',
      peerOrigin: 'https://b.example',
      triggerReason: 'space_join',
      triggerTarget: 'invite-y',
      createdAt: t0 + 100,
      readAt: t0 + 200,
    });
    seedNotification({
      id: 'notif-unread-2',
      userId: 'alice',
      kind: 'expired',
      peerOrigin: 'https://c.example',
      triggerReason: 'direct_message',
      triggerTarget: 'c@c.example',
      createdAt: t0 + 300,
      readAt: null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/federation/peering-notifications?unread=1',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { notifications: Array<{ id: string; readAt: number | null }> };
    expect(body.notifications).toHaveLength(2);
    // DESC ordering: unread-2 (newer) before unread-1 (older).
    expect(body.notifications.map(n => n.id)).toEqual(['notif-unread-2', 'notif-unread-1']);
    for (const n of body.notifications) {
      expect(n.readAt).toBeNull();
    }
  });

  // Test 26 (cross-user): GET shows only the requesting user's notifications.
  it('does NOT return other users\' notifications', async () => {
    seedNotification({
      id: 'alice-notif',
      userId: 'alice',
      kind: 'approved',
      peerOrigin: 'https://a.example',
      triggerReason: 'friend_add',
      triggerTarget: 'a@a.example',
      createdAt: 1,
      readAt: null,
    });
    seedNotification({
      id: 'bob-notif',
      userId: 'bob',
      kind: 'denied',
      peerOrigin: 'https://b.example',
      triggerReason: 'friend_add',
      triggerTarget: 'b@b.example',
      createdAt: 2,
      readAt: null,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/federation/peering-notifications',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { notifications: Array<{ id: string }> };
    expect(body.notifications).toHaveLength(1);
    // Alice's row comes back (isolation: bob-notif is excluded by userId filter
    // in the WHERE clause; the response shape itself no longer surfaces userId).
    expect(body.notifications[0]!.id).toBe('alice-notif');
  });
});

describe('POST /api/federation/peering-notifications/:id/read', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    seedUser('alice', 'alice');
    seedUser('bob', 'bob');
    currentUserId = 'alice';
    app = await buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  // Test 24: POST :id/read → sets readAt.
  it('marks the notification as read by setting readAt', async () => {
    const t0 = 1_700_000_000_000;
    seedNotification({
      id: 'notif-1',
      userId: 'alice',
      kind: 'approved',
      peerOrigin: 'https://a.example',
      triggerReason: 'friend_add',
      triggerTarget: 'a@a.example',
      createdAt: t0,
      readAt: null,
    });

    const before = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peering-notifications/notif-1/read',
    });
    const after = Date.now();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    const row = testDb.select()
      .from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'notif-1'))
      .get();
    expect(row).toBeDefined();
    expect(row!.readAt).not.toBeNull();
    expect(row!.readAt!).toBeGreaterThanOrEqual(before);
    expect(row!.readAt!).toBeLessThanOrEqual(after);
  });

  // Test 26: POST :id/read on another user's notif → 403.
  it("returns 403 when the notification belongs to another user; row UNTOUCHED", async () => {
    seedNotification({
      id: 'bob-notif',
      userId: 'bob',
      kind: 'denied',
      peerOrigin: 'https://b.example',
      triggerReason: 'friend_add',
      triggerTarget: 'b@b.example',
      createdAt: 1,
      readAt: null,
    });

    // currentUserId is alice; row belongs to bob.
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peering-notifications/bob-notif/read',
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: string }).error).toBe('forbidden');

    const row = testDb.select()
      .from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'bob-notif'))
      .get();
    expect(row!.readAt).toBeNull();
  });

  // Test 26: POST :id/read on non-existent → 404.
  it('returns 404 when the notification does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peering-notifications/does-not-exist/read',
    });

    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe('notification_not_found');
  });
});

describe('POST /api/federation/peering-notifications/read-all', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    seedUser('alice', 'alice');
    seedUser('bob', 'bob');
    currentUserId = 'alice';
    app = await buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  // Test 25: POST read-all → marks all unread as read; returns count.
  // Already-read rows are NOT touched (their readAt is preserved).
  it('marks the user\'s unread rows as read; preserves already-read readAt; returns affected count', async () => {
    const t0 = 1_700_000_000_000;
    const ALREADY_READ_AT = t0 + 50;

    seedNotification({
      id: 'unread-1',
      userId: 'alice',
      kind: 'approved',
      peerOrigin: 'https://a.example',
      triggerReason: 'friend_add',
      triggerTarget: 'a@a.example',
      createdAt: t0,
      readAt: null,
    });
    seedNotification({
      id: 'unread-2',
      userId: 'alice',
      kind: 'denied',
      peerOrigin: 'https://b.example',
      triggerReason: 'space_join',
      triggerTarget: 'invite-y',
      createdAt: t0 + 100,
      readAt: null,
    });
    seedNotification({
      id: 'already-read',
      userId: 'alice',
      kind: 'expired',
      peerOrigin: 'https://c.example',
      triggerReason: 'direct_message',
      triggerTarget: 'c@c.example',
      createdAt: t0 + 200,
      readAt: ALREADY_READ_AT,
    });

    const before = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peering-notifications/read-all',
    });
    const after = Date.now();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, count: 2 });

    const u1 = testDb.select().from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'unread-1')).get();
    const u2 = testDb.select().from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'unread-2')).get();
    const ar = testDb.select().from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'already-read')).get();

    expect(u1!.readAt).not.toBeNull();
    expect(u1!.readAt!).toBeGreaterThanOrEqual(before);
    expect(u1!.readAt!).toBeLessThanOrEqual(after);
    expect(u2!.readAt).not.toBeNull();
    expect(u2!.readAt!).toBeGreaterThanOrEqual(before);
    expect(u2!.readAt!).toBeLessThanOrEqual(after);

    // already-read row's readAt is preserved (unchanged).
    expect(ar!.readAt).toBe(ALREADY_READ_AT);
  });

  // Test 26: POST read-all only marks the requesting user's rows.
  it('does NOT touch other users\' notifications', async () => {
    seedNotification({
      id: 'alice-unread',
      userId: 'alice',
      kind: 'approved',
      peerOrigin: 'https://a.example',
      triggerReason: 'friend_add',
      triggerTarget: 'a@a.example',
      createdAt: 1,
      readAt: null,
    });
    seedNotification({
      id: 'bob-unread',
      userId: 'bob',
      kind: 'denied',
      peerOrigin: 'https://b.example',
      triggerReason: 'friend_add',
      triggerTarget: 'b@b.example',
      createdAt: 2,
      readAt: null,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peering-notifications/read-all',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, count: 1 });

    const aliceRow = testDb.select().from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'alice-unread')).get();
    const bobRow = testDb.select().from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'bob-unread')).get();

    expect(aliceRow!.readAt).not.toBeNull();
    expect(bobRow!.readAt).toBeNull();
  });
});
