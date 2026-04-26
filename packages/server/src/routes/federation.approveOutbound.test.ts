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

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('./federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

describe('POST /api/federation/approval-requests/:id/approve — outbound token forwarding & 202 capture', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    app = await buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('forwards approvalToken from peer_approval_requests in the outbound body', async () => {
    const now = Date.now();
    const token = 'a'.repeat(64);
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'req-1',
      origin: 'https://remote.example',
      instanceName: 'Remote',
      hmacSecret: 'remote-secret',
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      approvalToken: token,
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: true, instanceName: 'Remote' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-1/approve',
    });

    expect(response.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string) as { approvalToken?: string };
    expect(body.approvalToken).toBe(token);
  });

  it('omits approvalToken from outbound body when approval-request has null token (legacy)', async () => {
    const now = Date.now();
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'req-2',
      origin: 'https://remote.example',
      instanceName: 'Remote',
      hmacSecret: 'remote-secret',
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      approvalToken: null,
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: true, instanceName: 'Remote' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-2/approve',
    });

    expect(response.statusCode).toBe(200);
    const init = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string) as { approvalToken?: string };
    expect(body.approvalToken).toBeUndefined();
  });

  it('on 200 success, clears approvalToken on the new federation_peers row', async () => {
    const now = Date.now();
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'req-200',
      origin: 'https://remote.example',
      instanceName: 'Remote',
      hmacSecret: 'remote-secret',
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      approvalToken: 'a'.repeat(64),
    }).run();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: true, instanceName: 'Remote' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-200/approve',
    });

    expect(response.statusCode).toBe(200);
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('active');
    expect(peer?.approvalToken).toBeNull();
  });

  it('on 202 from remote, transitions local peer to awaiting_approval and stores returned approvalToken', async () => {
    const now = Date.now();
    const inboundToken = 'a'.repeat(64);
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'req-3',
      origin: 'https://remote.example',
      instanceName: 'Remote',
      hmacSecret: 'remote-secret',
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      approvalToken: inboundToken,
    }).run();

    const remoteToken = 'b'.repeat(64);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ queued: true, message: 'queued', approvalToken: remoteToken }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/approval-requests/req-3/approve',
    });

    expect(response.statusCode).toBe(200);
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('awaiting_approval');
    expect(peer?.approvalToken).toBe(remoteToken);
  });
});
