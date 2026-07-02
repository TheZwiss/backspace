import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';
import { buildFederationHeaders } from './federationAuth.js';

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
  requireAdmin: async () => {
    // peer/accept is unauthenticated anyway
  },
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

const LOCAL_EPOCH = 'local-epoch-0000';

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
    instanceId: LOCAL_EPOCH,
    autoAcceptPeering: 1,
    registrationOpen: 1,
    updatedAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('../routes/federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

describe('POST /api/federation/peer/accept — peer_instance_id (epoch) persistence', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    const { __resetInstanceIdCacheForTest } = await import('./federationEpoch.js');
    __resetInstanceIdCacheForTest();
    app = await buildApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('writes peer_instance_id when activating an existing pending peer', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-pending',
      origin: 'https://remote.example',
      hmacSecret: 'old-secret',
      status: 'pending',
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'new-secret',
        instanceName: 'Remote Backspace',
        instanceId: 'epoch-A',
      },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-pending')).get();
    expect(row?.status).toBe('active');
    expect(row?.peerInstanceId).toBe('epoch-A');
  });

  it('writes peer_instance_id when creating a brand-new peer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'remote-secret',
        instanceName: 'Remote Backspace',
        instanceId: 'epoch-B',
      },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.status).toBe('active');
    expect(row?.peerInstanceId).toBe('epoch-B');
  });

  it('writes peer_instance_id when overriding rejected → active', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-rejected',
      origin: 'https://remote.example',
      hmacSecret: 'old-secret',
      status: 'rejected',
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'new-secret',
        instanceId: 'epoch-C',
      },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-rejected')).get();
    expect(row?.status).toBe('active');
    expect(row?.peerInstanceId).toBe('epoch-C');
  });

  it('writes peer_instance_id on the awaiting_approval autoAccept fallback path', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-await',
      origin: 'https://remote.example',
      hmacSecret: 'old-secret',
      status: 'awaiting_approval',
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'new-secret',
        instanceId: 'epoch-D',
      },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-await')).get();
    expect(row?.status).toBe('active');
    expect(row?.peerInstanceId).toBe('epoch-D');
  });

  it('writes null peer_instance_id when body omits instanceId (legacy peer)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'remote-secret',
        instanceName: 'Remote Backspace',
      },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.status).toBe('active');
    expect(row?.peerInstanceId).toBeNull();
  });

  it('returns our own instanceId in the response body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'remote-secret',
        instanceId: 'epoch-E',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { accepted: boolean; instanceName?: string | null; instanceId?: string };
    expect(body.accepted).toBe(true);
    expect(body.instanceId).toBe(LOCAL_EPOCH);
  });
});

describe('POST /api/federation/peer/initiate — verifies the handshake before persisting remote epoch', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    const { __resetInstanceIdCacheForTest } = await import('./federationEpoch.js');
    __resetInstanceIdCacheForTest();
    app = await buildApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('activates and persists peer_instance_id after a verified /epoch round-trip', async () => {
    // The responder signs the /epoch response with the SAME secret the initiator
    // sent it in /peer/accept — mirroring a real responder that adopted the secret.
    let capturedSecret = '';
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/federation/peer/accept')) {
        capturedSecret = (JSON.parse(String(init?.body)) as { hmacSecret: string }).hmacSecret;
        return new Response(JSON.stringify({ accepted: true, instanceName: 'Remote', instanceId: 'remote-epoch-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.endsWith('/api/federation/epoch')) {
        const body = JSON.stringify({ instanceId: 'remote-epoch-1' });
        const headers = buildFederationHeaders(body, capturedSecret, 'https://remote.example');
        return new Response(body, { status: 200, headers });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: 'https://remote.example' },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { verified?: boolean }).verified).toBe(true);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.status).toBe('active');
    expect(row?.peerInstanceId).toBe('remote-epoch-1');

    // Our epoch must be sent in the outbound handshake body.
    const acceptCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/federation/peer/accept')) as unknown as [string, RequestInit];
    const sentBody = JSON.parse(acceptCall[1].body as string) as { instanceId?: string };
    expect(sentBody.instanceId).toBe(LOCAL_EPOCH);
  });

  it('parks in needs_attention when the /epoch verification cannot complete (legacy/unverifiable peer)', async () => {
    // Remote returns 200 on /peer/accept but has no verifiable /epoch endpoint
    // (404 → legacy). Without a signed round-trip we refuse to false-activate.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/federation/peer/accept')) {
        return new Response(JSON.stringify({ accepted: true, instanceName: 'Remote' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.endsWith('/api/federation/epoch')) return new Response('not found', { status: 404 });
      throw new Error(`unexpected fetch ${u}`);
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: 'https://remote.example' },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { verified?: boolean }).verified).toBe(false);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.status).toBe('needs_attention');
    expect(row?.needsAttentionReason).toBe('repeer_incomplete');
    expect(row?.peerInstanceId).toBeNull();
  });
});
