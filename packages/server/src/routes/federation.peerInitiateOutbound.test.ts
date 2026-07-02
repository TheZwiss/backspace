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
import { buildFederationHeaders } from '../utils/federationAuth.js';

setWorkerId(1);

// The pending row's secret is deterministic in this suite (generateHmacSecret is
// mocked below to return this exact value). fetchPeerEpoch signs its /epoch
// request with the pending row's secret and verifies the response with the same
// secret, so a valid signed epoch response must be signed with THIS secret.
const PENDING_SECRET = 'mock-generated-secret';

/**
 * URL-aware outbound fetch stub. `/peer/accept` returns `acceptResponse`; the
 * subsequent `/api/federation/epoch` call returns a valid HMAC-signed
 * `{ instanceId }` (signed with the pending row's secret so fetchPeerEpoch's real
 * signature check passes) when `epochToEcho` is a string, or `401` when null.
 */
function makeUrlAwareFetch(acceptResponse: Response, epochToEcho: string | null): typeof globalThis.fetch {
  return (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    if (u.endsWith('/api/federation/peer/accept')) return acceptResponse.clone();
    if (u.endsWith('/api/federation/epoch')) {
      if (epochToEcho === null) return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
      const body = JSON.stringify({ instanceId: epochToEcho });
      const headers = buildFederationHeaders(body, PENDING_SECRET, 'https://remote.example');
      return new Response(body, { status: 200, headers });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof globalThis.fetch;
}

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
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeUrlAwareFetch(
      new Response(
        JSON.stringify({ accepted: true, instanceName: 'Remote', instanceId: 'remote-epoch' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
      'remote-epoch',
    ));

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

  // ─── Task 6: 409 honest-refusal + verify-before-activate (BUG-1b/BUG-2) ─────

  it('(a) on 409 PEER_EXISTS_RESET_REQUIRED, returns 409 and DELETES the pending row', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeUrlAwareFetch(
      new Response(
        JSON.stringify({ accepted: false, code: 'PEER_EXISTS_RESET_REQUIRED', error: 'reset required' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
      // No epoch call is expected on this path; guard with null anyway.
      null,
    ));

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: 'https://remote.example' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('PEER_EXISTS_RESET_REQUIRED');

    // The pending row must be gone — no false-active, no lingering slot.
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer).toBeUndefined();
  });

  it('(b) on 200 but failed epoch verification, parks in needs_attention (verified:false), NOT active', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeUrlAwareFetch(
      new Response(
        JSON.stringify({ accepted: true, instanceName: 'Remote', instanceId: 'remote-epoch' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
      // Epoch endpoint responds 401 → fetchPeerEpoch returns null.
      null,
    ));

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: 'https://remote.example' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().verified).toBe(false);

    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('needs_attention');
    expect(peer?.needsAttentionReason).toBe('repeer_incomplete');
    expect(peer?.status).not.toBe('active');
  });

  it('(c) on 200 with a valid signed epoch, activates (verified:true) and clears needsAttentionReason', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeUrlAwareFetch(
      new Response(
        JSON.stringify({ accepted: true, instanceName: 'Remote', instanceId: 'remote-epoch' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
      'remote-epoch',
    ));

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: 'https://remote.example' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().verified).toBe(true);

    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('active');
    expect(peer?.needsAttentionReason).toBeNull();
    expect(peer?.peerInstanceId).toBe('remote-epoch');
  });
});
