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
    instanceId: 'test-epoch-local',
    autoAcceptPeering: autoAccept,
    registrationOpen: 1,
    updatedAt: Date.now(),
  }).run();
}

const REMOTE = 'https://remote.example';

function seedPeer(
  status: 'pending' | 'awaiting_approval',
  initiatedBy: 'admin' | 'auto' | 'remote',
  approvalToken: string | null = null,
): void {
  testDb.insert(schema.federationPeers).values({
    id: 'peer-row',
    origin: REMOTE,
    hmacSecret: 'old-secret',
    status,
    initiatedBy,
    approvalToken,
    createdAt: Date.now(),
  }).run();
}

function peerRow() {
  return testDb.select().from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, REMOTE)).get();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('./federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

/**
 * With `autoAcceptPeering = 0` the inbound `/peer/accept` gate treats a local
 * `pending` / `awaiting_approval` row as standing proof that the local admin
 * already authorized peering with that origin. Rows created by user traffic
 * (the outbox placeholder, auto-peering) are not that proof, so they must not
 * open the gate. `initiated_by` is what separates the two.
 */
describe('POST /api/federation/peer/accept — peer-row provenance gates manual approval', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
  });

  async function start(autoAccept: 0 | 1): Promise<void> {
    seedInstanceSettings(autoAccept);
    app = await buildApp();
  }

  async function inboundAccept(approvalToken?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: REMOTE,
        hmacSecret: 'attacker-secret',
        instanceName: 'Remote',
        ...(approvalToken ? { approvalToken } : {}),
      },
    });
  }

  it('does not activate against a non-admin pending row (autoAccept=0)', async () => {
    await start(0);
    seedPeer('pending', 'auto');

    const response = await inboundAccept();

    expect(response.statusCode).toBe(202);
    const peer = peerRow();
    expect(peer?.status).toBe('pending');
    expect(peer?.hmacSecret).toBe('old-secret');
    const queued = testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.origin, REMOTE)).get();
    expect(queued).toBeTruthy();
  });

  it('activates against an admin-initiated pending row (autoAccept=0)', async () => {
    // POSITIVE CONTROL for the case above: identical request, identical row,
    // only the provenance differs. Proves the harness reaches the activation
    // branch, so the 202 above is caused by provenance and nothing else.
    await start(0);
    seedPeer('pending', 'admin');

    const response = await inboundAccept();

    expect(response.statusCode).toBe(200);
    const peer = peerRow();
    expect(peer?.status).toBe('active');
    expect(peer?.hmacSecret).toBe('attacker-secret');
  });

  it('does not promote a non-admin awaiting_approval row even with a matching token (autoAccept=0)', async () => {
    await start(0);
    const token = 'd'.repeat(64);
    seedPeer('awaiting_approval', 'auto', token);

    const response = await inboundAccept(token);

    expect(response.statusCode).toBe(202);
    const peer = peerRow();
    expect(peer?.status).toBe('awaiting_approval');
    expect(peer?.hmacSecret).toBe('old-secret');
  });

  it('promotes an admin-initiated awaiting_approval row with a matching token (autoAccept=0)', async () => {
    // POSITIVE CONTROL for the case above.
    await start(0);
    const token = 'e'.repeat(64);
    seedPeer('awaiting_approval', 'admin', token);

    const response = await inboundAccept(token);

    expect(response.statusCode).toBe(200);
    const peer = peerRow();
    expect(peer?.status).toBe('active');
    expect(peer?.hmacSecret).toBe('attacker-secret');
  });

  it('still activates a non-admin pending row when autoAccept=1 (default config unchanged)', async () => {
    await start(1);
    seedPeer('pending', 'auto');

    const response = await inboundAccept();

    expect(response.statusCode).toBe(200);
    expect(peerRow()?.status).toBe('active');
  });

  it('records admin provenance on the row /peer/initiate creates', async () => {
    await start(0);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network down');
    });
    process.env.DOMAIN = 'local.example';

    // The handshake fails at the network step, but the row's provenance is
    // written before the fetch — read it from the failure path's cleanup-free
    // sibling: re-run with a 202 response so the row survives as
    // awaiting_approval.
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ approvalToken: 'f'.repeat(64) }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: REMOTE },
    });

    expect(response.statusCode).toBe(202);
    const peer = peerRow();
    expect(peer?.status).toBe('awaiting_approval');
    expect(peer?.initiatedBy).toBe('admin');
    fetchSpy.mockRestore();
  });
});
