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

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = 'admin-user';
  },
  requireAdmin: async () => {},
}));

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

function seedInstanceSettings(autoAccept: 0 | 1): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceName: 'Local Backspace',
    autoAcceptPeering: autoAccept,
    registrationOpen: 1,
    updatedAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('./federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

describe('POST /api/federation/peer/accept — approval token verification', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
  });

  async function setupAutoAccept(value: 0 | 1): Promise<void> {
    seedInstanceSettings(value);
    app = await buildApp();
  }

  it('queueing path stores token on peer_approval_requests and returns it in the 202 body (autoAccept=0, no existing peer)', async () => {
    await setupAutoAccept(0);

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'remote-secret',
        instanceName: 'Remote',
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { queued: boolean; approvalToken?: string };
    expect(body.queued).toBe(true);
    expect(typeof body.approvalToken).toBe('string');
    expect(body.approvalToken).toMatch(/^[0-9a-f]{64}$/);

    const row = testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.origin, 'https://remote.example')).get();
    expect(row?.approvalToken).toBe(body.approvalToken);
  });

  it('regenerates token on re-handshake (existing approval-request row gets new token)', async () => {
    await setupAutoAccept(0);

    const now = Date.now();
    const oldToken = 'old-token-' + 'a'.repeat(53);
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'approval-old',
      origin: 'https://remote.example',
      instanceName: 'Remote',
      hmacSecret: 'old-secret',
      requestedAt: now - 1000,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      approvalToken: oldToken,
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'fresh-secret',
        instanceName: 'Remote',
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { queued: boolean; approvalToken?: string };
    expect(body.approvalToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.approvalToken).not.toBe(oldToken);

    const row = testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.origin, 'https://remote.example')).get();
    expect(row?.approvalToken).toBe(body.approvalToken);
    expect(row?.hmacSecret).toBe('fresh-secret');
  });

  it('promotes awaiting_approval → active when token matches (autoAccept=0)', async () => {
    await setupAutoAccept(0);

    const token = 'a'.repeat(64);
    testDb.insert(schema.federationPeers).values({
      id: 'peer-pending',
      origin: 'https://remote.example',
      hmacSecret: 'old-secret',
      status: 'awaiting_approval',
      approvalToken: token,
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'fresh-secret',
        instanceName: 'Remote',
        approvalToken: token,
      },
    });

    expect(response.statusCode).toBe(200);
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('active');
    expect(peer?.hmacSecret).toBe('fresh-secret');
    expect(peer?.approvalToken).toBeNull();
  });

  it('on successful match, deletes any stale approval-request row for the same origin', async () => {
    await setupAutoAccept(0);
    const token = 'b'.repeat(64);
    const now = Date.now();
    testDb.insert(schema.federationPeers).values({
      id: 'peer-pending',
      origin: 'https://remote.example',
      hmacSecret: 'old-secret',
      status: 'awaiting_approval',
      approvalToken: token,
      createdAt: now,
    }).run();
    // Stale approval-request from a prior bypass attempt (e.g., bug-prone code path).
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'stale-request',
      origin: 'https://remote.example',
      instanceName: 'Remote',
      hmacSecret: 'bypass-secret',
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      approvalToken: 'stale-token',
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'fresh-secret',
        approvalToken: token,
      },
    });

    expect(response.statusCode).toBe(200);
    const stale = testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.origin, 'https://remote.example')).get();
    expect(stale).toBeUndefined();
  });

  it('autoAccept=0 + missing token → does NOT promote, queues new approval-request', async () => {
    await setupAutoAccept(0);
    const token = 'c'.repeat(64);
    testDb.insert(schema.federationPeers).values({
      id: 'peer-pending',
      origin: 'https://remote.example',
      hmacSecret: 'old-secret',
      status: 'awaiting_approval',
      approvalToken: token,
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'bypass-secret',
        // no approvalToken
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { queued: boolean; approvalToken?: string };
    expect(body.queued).toBe(true);
    expect(typeof body.approvalToken).toBe('string');

    // Existing awaiting_approval peer row UNCHANGED.
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('awaiting_approval');
    expect(peer?.hmacSecret).toBe('old-secret');
    expect(peer?.approvalToken).toBe(token);

    // New approval-request row exists with a fresh token (different from the existing peer's).
    const req = testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.origin, 'https://remote.example')).get();
    expect(req?.approvalToken).toBe(body.approvalToken);
    expect(req?.approvalToken).not.toBe(token);
  });

  it('autoAccept=0 + mismatched token → behaves the same as missing token (queues)', async () => {
    await setupAutoAccept(0);
    testDb.insert(schema.federationPeers).values({
      id: 'peer-pending',
      origin: 'https://remote.example',
      hmacSecret: 'old-secret',
      status: 'awaiting_approval',
      approvalToken: 'd'.repeat(64),
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'bypass-secret',
        approvalToken: 'e'.repeat(64),
      },
    });

    expect(response.statusCode).toBe(202);
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('awaiting_approval');
  });

  it('autoAccept=0 + null stored token (legacy) + no inbound token → queues (does not promote)', async () => {
    await setupAutoAccept(0);
    testDb.insert(schema.federationPeers).values({
      id: 'peer-legacy',
      origin: 'https://remote.example',
      hmacSecret: 'old-secret',
      status: 'awaiting_approval',
      approvalToken: null,
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'fresh-secret',
      },
    });

    expect(response.statusCode).toBe(202);
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('awaiting_approval');
  });

  it('autoAccept=1 + missing/mismatched token → fallback promotes (no security regression)', async () => {
    await setupAutoAccept(1);
    testDb.insert(schema.federationPeers).values({
      id: 'peer-pending',
      origin: 'https://remote.example',
      hmacSecret: 'old-secret',
      status: 'awaiting_approval',
      approvalToken: 'f'.repeat(64),
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'fresh-secret',
        // no approvalToken
      },
    });

    expect(response.statusCode).toBe(200);
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('active');
    expect(peer?.hmacSecret).toBe('fresh-secret');
    expect(peer?.approvalToken).toBeNull();
  });
});
