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

// getOurOrigin returns an origin DISTINCT from `https://${config.domain}`
// (config.domain === 'local.example'). This simulates PUBLIC_ORIGIN being set
// to something other than https://DOMAIN — the exact configuration that exposed
// the handshake/S2S-auth origin desync (BUG: resolveLocalOrigin used DOMAIN).
const PUBLIC_ORIGIN = 'https://public.example';
vi.mock('../utils/federationAuth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationAuth.js')>('../utils/federationAuth.js');
  return {
    ...actual,
    getOurOrigin: () => 'https://public.example',
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
    instanceId: 'test-epoch-local',
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

describe('POST /api/federation/peer/initiate — 202 token capture & 200 clear', () => {
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

  it('on 202 from remote, transitions local peer to awaiting_approval and stores returned approvalToken', async () => {
    const remoteToken = 'c'.repeat(64);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ queued: true, message: 'queued', approvalToken: remoteToken }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: 'https://remote.example' },
    });

    expect(response.statusCode).toBe(202);
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('awaiting_approval');
    expect(peer?.approvalToken).toBe(remoteToken);
  });

  it('handshake sourceOrigin equals getOurOrigin() (honors PUBLIC_ORIGIN), not https://DOMAIN', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: true, instanceName: 'Remote' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: 'https://remote.example' },
    });

    expect(response.statusCode).toBe(200);

    // Locate the outbound handshake call to the remote /peer/accept endpoint.
    const acceptCall = fetchSpy.mock.calls.find(([url]) =>
      String(url) === 'https://remote.example/api/federation/peer/accept',
    );
    expect(acceptCall).toBeDefined();

    const init = acceptCall![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { sourceOrigin: string };

    // The handshake sourceOrigin MUST match the origin used for S2S auth
    // (getOurOrigin / PUBLIC_ORIGIN), so the responder keys the peer row by the
    // same value it will later see in X-Federation-Origin.
    expect(body.sourceOrigin).toBe(PUBLIC_ORIGIN);
    // And it must NOT fall back to https://DOMAIN when PUBLIC_ORIGIN differs.
    expect(body.sourceOrigin).not.toBe('https://local.example');
  });

  it('on 200 from remote, activates and clears approvalToken', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: true, instanceName: 'Remote' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: 'https://remote.example' },
    });

    expect(response.statusCode).toBe(200);
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('active');
    expect(peer?.approvalToken).toBeNull();
  });
});
