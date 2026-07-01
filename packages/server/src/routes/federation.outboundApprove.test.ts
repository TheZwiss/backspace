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

// Mock the activation module entirely. The route handler is responsible for
// CALLING onPeerActivated on the 200 path; we assert that here. The fanout
// behavior itself is covered by federationPeerActivation.outboundFanout.test.ts
// (Task 6) — keeping that separation avoids running real network sync from
// inside a route test.
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
  instanceName?: string | null;
  subscribers: Array<{ userId: string; reason: 'friend_add' | 'space_join' | 'direct_message'; target: string }>;
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

describe('POST /api/federation/approval-requests/:id/approve — outbound direction', () => {
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

  // Test 13: 200 outbound activates peer + delegates fanout to onPeerActivated.
  it('200 from remote → peer becomes active; delegates fanout to onPeerActivated; handler does NOT manually clean subscribers', async () => {
    seedOutboundRequest({
      id: 'req-out-200',
      origin: 'https://remote.example',
      instanceName: 'Remote Inst',
      subscribers: [
        { userId: 'alice', reason: 'friend_add', target: 'someone@remote.example' },
        { userId: 'bob', reason: 'friend_add', target: 'other@remote.example' },
      ],
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: true, instanceName: 'Remote Backspace' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-out-200/approve',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { success: boolean; peerStatus: string };
    expect(body.success).toBe(true);
    expect(body.peerStatus).toBe('active');

    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('active');
    expect(peer?.instanceName).toBe('Remote Backspace');
    expect(peer?.approvalToken).toBeNull();

    // Handler delegates fanout: onPeerActivated MUST be called with the new peer's id.
    expect(onPeerActivatedMock).toHaveBeenCalledTimes(1);
    expect(onPeerActivatedMock).toHaveBeenCalledWith(peer!.id, 'approval_handshake');

    // The handler must NOT pre-emptively clean up subscribers — that's
    // onPeerActivated's job. Since we mocked onPeerActivated, the parent +
    // subscribers should still be present here. (In production, the real
    // onPeerActivated then cascades them; covered by Task 6's fanout test.)
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-out-200')).get()).toBeDefined();
    expect(testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.requestId, 'req-out-200')).all()).toHaveLength(2);

    // No notifications written by the handler directly.
    expect(testDb.select().from(schema.peerApprovalNotifications).all()).toHaveLength(0);

    // No peering_notification_received fired by the handler.
    const peeringEvents = sentToUser.mock.calls.filter(call => {
      const ev = call[1] as { type?: string };
      return ev?.type === 'peering_notification_received';
    });
    expect(peeringEvents).toHaveLength(0);
  });

  // Test 14: 202 outbound transitions to awaiting_approval and leaves queue intact.
  it('202 from remote → peer becomes awaiting_approval, captures approvalToken, queue + subscribers REMAIN, onPeerActivated NOT called', async () => {
    seedOutboundRequest({
      id: 'req-out-202',
      origin: 'https://remote.example',
      subscribers: [
        { userId: 'alice', reason: 'friend_add', target: 'someone@remote.example' },
      ],
    });

    const remoteToken = 'a'.repeat(64);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ queued: true, approvalToken: remoteToken }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-out-202/approve',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { success: boolean; peerStatus: string };
    expect(body.success).toBe(true);
    expect(body.peerStatus).toBe('awaiting_approval');

    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('awaiting_approval');
    expect(peer?.approvalToken).toBe(remoteToken);

    // Outbound queue row + subscribers REMAIN — they wait for full activation.
    const stillQueued = testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-out-202')).get();
    expect(stillQueued).toBeDefined();
    expect(stillQueued?.direction).toBe('outbound');
    const stillSubscribed = testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.requestId, 'req-out-202')).all();
    expect(stillSubscribed).toHaveLength(1);

    // onPeerActivated must NOT be called — peer is not yet active.
    expect(onPeerActivatedMock).not.toHaveBeenCalled();

    // No notifications written.
    expect(testDb.select().from(schema.peerApprovalNotifications).all()).toHaveLength(0);

    // No peering_notification_received fired.
    const peeringEvents = sentToUser.mock.calls.filter(call => {
      const ev = call[1] as { type?: string };
      return ev?.type === 'peering_notification_received';
    });
    expect(peeringEvents).toHaveLength(0);
  });

  // Test 15: network error returns 503; peer cleaned up; queue intact.
  it('network error from remote → 503; peer row cleaned up; queue + subscribers REMAIN; onPeerActivated NOT called', async () => {
    seedOutboundRequest({
      id: 'req-out-net',
      origin: 'https://remote.example',
      subscribers: [
        { userId: 'alice', reason: 'friend_add', target: 'someone@remote.example' },
      ],
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed: connection refused'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-out-net/approve',
    });

    expect(response.statusCode).toBe(503);

    // Peer row cleaned up.
    expect(testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get()).toBeUndefined();

    // Queue + subscribers UNTOUCHED for admin retry.
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-out-net')).get()).toBeDefined();
    expect(testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.requestId, 'req-out-net')).all()).toHaveLength(1);

    expect(onPeerActivatedMock).not.toHaveBeenCalled();
    expect(testDb.select().from(schema.peerApprovalNotifications).all()).toHaveLength(0);
  });

  it('5xx from remote → 502; peer row cleaned up; queue + subscribers REMAIN', async () => {
    seedOutboundRequest({
      id: 'req-out-500',
      origin: 'https://remote.example',
      subscribers: [
        { userId: 'alice', reason: 'friend_add', target: 'someone@remote.example' },
      ],
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'remote boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-out-500/approve',
    });

    expect(response.statusCode).toBe(502);
    const body = response.json() as { remoteStatus?: number };
    expect(body.remoteStatus).toBe(500);

    expect(testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get()).toBeUndefined();
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-out-500')).get()).toBeDefined();
    expect(testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.requestId, 'req-out-500')).all()).toHaveLength(1);
  });

  it('does NOT forward approvalToken in outbound /peer/accept body (we hold no remote token)', async () => {
    seedOutboundRequest({
      id: 'req-out-noforward',
      origin: 'https://remote.example',
      subscribers: [
        { userId: 'alice', reason: 'friend_add', target: 'x@remote.example' },
      ],
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, instanceName: 'R' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-out-noforward/approve',
    });

    const init = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string) as { approvalToken?: string; sourceOrigin?: string; hmacSecret?: string };
    expect(body.approvalToken).toBeUndefined();
    expect(body.sourceOrigin).toBe('https://local.example');
    expect(body.hmacSecret).toBe('mock-generated-secret');
  });
});

describe('GET /api/federation/approval-requests — direction + outbound subscribers in response shape', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    seedUser('alice', 'alice');
    seedUser('bob', 'bob');
    app = await buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('inbound rows have no subscribers field; outbound rows include subscriber summaries with username', async () => {
    const now = Date.now();
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'req-inbound',
      origin: 'https://inbound.example',
      direction: 'inbound',
      instanceName: 'Inbound',
      hmacSecret: 'their-secret',
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    }).run();
    seedOutboundRequest({
      id: 'req-outbound',
      origin: 'https://outbound.example',
      instanceName: null,
      subscribers: [
        { userId: 'alice', reason: 'friend_add', target: 'a@outbound.example' },
        { userId: 'bob', reason: 'space_join', target: 'invite-code-xyz' },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/federation/approval-requests',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      requests: Array<{
        id: string;
        direction: string;
        subscribers?: Array<{ userId: string; username: string; triggerReason: string; triggerTarget: string }>;
      }>;
    };
    const inbound = body.requests.find(r => r.id === 'req-inbound');
    const outbound = body.requests.find(r => r.id === 'req-outbound');
    expect(inbound).toBeDefined();
    expect(inbound?.direction).toBe('inbound');
    expect(inbound?.subscribers).toBeUndefined();

    expect(outbound).toBeDefined();
    expect(outbound?.direction).toBe('outbound');
    expect(outbound?.subscribers).toBeDefined();
    expect(outbound?.subscribers).toHaveLength(2);
    const usernames = new Set(outbound!.subscribers!.map(s => s.username));
    expect(usernames).toEqual(new Set(['alice', 'bob']));
    const reasons = new Set(outbound!.subscribers!.map(s => s.triggerReason));
    expect(reasons).toEqual(new Set(['friend_add', 'space_join']));
  });

  it('outbound row with zero subscribers returns subscribers: [] (not undefined)', async () => {
    const now = Date.now();
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'req-empty-out',
      origin: 'https://lonely.example',
      direction: 'outbound',
      instanceName: null,
      hmacSecret: null,
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/federation/approval-requests',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      requests: Array<{ id: string; direction: string; subscribers?: unknown }>;
    };
    const row = body.requests.find(r => r.id === 'req-empty-out');
    expect(row?.direction).toBe('outbound');
    expect(Array.isArray(row?.subscribers)).toBe(true);
    expect(row?.subscribers).toEqual([]);
  });
});
