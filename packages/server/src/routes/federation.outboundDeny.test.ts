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
    req.userId = 'admin-user';
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

const onPeerActivatedMock = vi.fn(async () => undefined);
vi.mock('../utils/federationPeerActivation.js', () => ({
  onPeerActivated: onPeerActivatedMock,
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
    instanceId: 'test-epoch-local',
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

function seedOutboundRequest(opts: {
  id: string;
  origin: string;
  subscribers: Array<{ userId: string; reason: 'friend_add' | 'space_join' | 'direct_message'; target: string }>;
}): void {
  const now = Date.now();
  testDb.insert(schema.peerApprovalRequests).values({
    id: opts.id,
    origin: opts.origin,
    direction: 'outbound',
    instanceName: null,
    hmacSecret: null,
    requestedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    approvalToken: null,
  }).run();
  for (const sub of opts.subscribers) {
    testDb.insert(schema.peerApprovalSubscribers).values({
      id: `sub-${opts.id}-${sub.userId}`,
      requestId: opts.id,
      userId: sub.userId,
      triggerReason: sub.reason,
      triggerTarget: sub.target,
      createdAt: now,
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

describe('POST /api/federation/approval-requests/:id/deny — outbound direction', () => {
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
    onPeerActivatedMock.mockClear();
    app = await buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  // Test 16: outbound deny fans out denied notifications + cascade-deletes.
  it('outbound deny → writes denied notifications for each subscriber, sends WS to each, cascade-deletes parent + subscribers, broadcasts admin event', async () => {
    seedOutboundRequest({
      id: 'req-out-deny',
      origin: 'https://remote.example',
      subscribers: [
        { userId: 'alice', reason: 'friend_add', target: 'someone@remote.example' },
        { userId: 'bob', reason: 'space_join', target: 'invite-xyz' },
      ],
    });

    // No fetch should be invoked — outbound deny has no remote network call.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-out-deny/deny',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    // No remote network call.
    expect(fetchSpy).not.toHaveBeenCalled();

    // Two denied notifications written.
    const notifications = testDb.select().from(schema.peerApprovalNotifications).all();
    expect(notifications).toHaveLength(2);
    expect(notifications.every(n => n.kind === 'denied')).toBe(true);
    expect(notifications.every(n => n.peerOrigin === 'https://remote.example')).toBe(true);
    expect(notifications.every(n => n.readAt === null)).toBe(true);
    const userIds = new Set(notifications.map(n => n.userId));
    expect(userIds).toEqual(new Set(['alice', 'bob']));
    // Trigger reason + target captured per row.
    const aliceN = notifications.find(n => n.userId === 'alice');
    expect(aliceN?.triggerReason).toBe('friend_add');
    expect(aliceN?.triggerTarget).toBe('someone@remote.example');
    const bobN = notifications.find(n => n.userId === 'bob');
    expect(bobN?.triggerReason).toBe('space_join');
    expect(bobN?.triggerTarget).toBe('invite-xyz');

    // Parent + subscribers gone (cascade).
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-out-deny')).get()).toBeUndefined();
    expect(testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.requestId, 'req-out-deny')).all()).toHaveLength(0);

    // Each subscriber received a peering_notification_received WS.
    const peeringEvents = sentToUser.mock.calls.filter(call => {
      const ev = call[1] as { type?: string; kind?: string };
      return ev?.type === 'peering_notification_received' && ev?.kind === 'denied';
    });
    expect(peeringEvents).toHaveLength(2);

    // Admins notified that queue changed.
    const adminEvents = sentToAdmins.mock.calls.filter(call => {
      const ev = call[0] as { type?: string };
      return ev?.type === 'federation_peers_changed';
    });
    expect(adminEvents.length).toBeGreaterThanOrEqual(1);

    // No federation_peers row created — outbound deny has no peer to mark rejected.
    expect(testDb.select().from(schema.federationPeers).all()).toHaveLength(0);
  });

  it('outbound deny with zero subscribers still cascade-deletes parent and broadcasts admin event', async () => {
    const now = Date.now();
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'req-out-empty',
      origin: 'https://lonely.example',
      direction: 'outbound',
      instanceName: null,
      hmacSecret: null,
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      approvalToken: null,
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-out-empty/deny',
    });

    expect(response.statusCode).toBe(200);
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-out-empty')).get()).toBeUndefined();
    expect(testDb.select().from(schema.peerApprovalNotifications).all()).toHaveLength(0);

    const adminEvents = sentToAdmins.mock.calls.filter(call => {
      const ev = call[0] as { type?: string };
      return ev?.type === 'federation_peers_changed';
    });
    expect(adminEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('non-existent id returns 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/does-not-exist/deny',
    });
    expect(response.statusCode).toBe(404);
  });
});

// Test 17: regression — inbound paths still behave as before the direction split.
describe('Inbound regression after direction split', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    seedUser('alice', 'alice');
    sentToUser.mockClear();
    sentToAdmins.mockClear();
    onPeerActivatedMock.mockClear();
    app = await buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  function seedInboundRequest(id: string): void {
    const now = Date.now();
    testDb.insert(schema.peerApprovalRequests).values({
      id,
      origin: 'https://inbound.example',
      direction: 'inbound',
      instanceName: 'Inbound',
      hmacSecret: 'their-secret',
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    }).run();
  }

  it('/approve on inbound row → existing 200 path activates peer (preserved verbatim)', async () => {
    seedInboundRequest('req-in-approve');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, instanceName: 'Inbound Backspace' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-in-approve/approve',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { success: boolean; peer?: { status?: string } };
    expect(body.success).toBe(true);
    // Inbound preserves the existing response shape: `peer` is included,
    // `peerStatus` is NOT (that's outbound's signal).
    expect(body.peer).toBeDefined();

    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://inbound.example')).get();
    expect(peer?.status).toBe('active');
    expect(peer?.instanceName).toBe('Inbound Backspace');

    // Inbound 200 path deletes the queue row directly (not via onPeerActivated).
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-in-approve')).get()).toBeUndefined();

    // Still calls onPeerActivated for sync-pull / outbox reset.
    expect(onPeerActivatedMock).toHaveBeenCalledWith(peer!.id, 'approval_handshake');
  });

  it('/deny on inbound row → calls remote /peer/denied, marks peer rejected, deletes queue row', async () => {
    seedInboundRequest('req-in-deny');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-in-deny/deny',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    // Remote /peer/denied invoked.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe('https://inbound.example/api/federation/peer/denied');

    // Local peer row inserted as 'rejected'.
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://inbound.example')).get();
    expect(peer?.status).toBe('rejected');

    // Queue row deleted.
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-in-deny')).get()).toBeUndefined();

    // No subscriber notifications (those are outbound-only).
    expect(testDb.select().from(schema.peerApprovalNotifications).all()).toHaveLength(0);
  });

  it('/deny on inbound row with unreachable remote returns 502 and leaves queue row pending', async () => {
    seedInboundRequest('req-in-deny-fail');

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection refused'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-in-deny-fail/deny',
    });

    expect(response.statusCode).toBe(502);

    // Queue row still pending — admin can retry.
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-in-deny-fail')).get()).toBeDefined();
    // No federation_peers row created because we couldn't deliver the denial.
    expect(testDb.select().from(schema.federationPeers).all()).toHaveLength(0);
  });
});
