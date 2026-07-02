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

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = 'admin-user';
  },
  requireAdmin: async () => {
    // no-op (peer/accept endpoint is unauthenticated anyway)
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

function seedInstanceSettings(name: string): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceName: name,
    instanceId: 'test-epoch-local',
    autoAcceptPeering: 1,
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

describe('POST /api/federation/peer/accept — instance_name persistence', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings('Local Backspace');
    app = await buildApp();
  });

  it('writes instance_name when creating a new peer (autoAccept=1, no existing row)', async () => {
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
    expect(row).toBeTruthy();
    expect(row?.instanceName).toBe('Remote Backspace');
    expect(row?.status).toBe('active');
  });

  it('writes instance_name when activating an existing pending peer', async () => {
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
      },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-pending')).get();
    expect(row?.instanceName).toBe('Remote Backspace');
    expect(row?.status).toBe('active');
  });

  it('writes instance_name when activating an existing awaiting_approval peer', async () => {
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
        instanceName: 'Remote Backspace',
      },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-await')).get();
    expect(row?.instanceName).toBe('Remote Backspace');
    expect(row?.status).toBe('active');
  });

  it('writes instance_name when overriding rejected → active', async () => {
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
        instanceName: 'Remote Backspace',
      },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-rejected')).get();
    expect(row?.instanceName).toBe('Remote Backspace');
    expect(row?.status).toBe('active');
  });

  it('does NOT overwrite instance_name on the active idempotent early-return path (now 409)', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-active',
      origin: 'https://remote.example',
      hmacSecret: 'existing-secret',
      status: 'active',
      instanceName: 'Original Name',
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'attacker-secret',
        instanceName: 'Attacker Name',
      },
    });

    // BUG-1a: existing active peer now returns an honest 409 refusal, not a
    // false 200. Anti-hijack unchanged — name/secret must be untouched.
    expect(response.statusCode).toBe(409);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-active')).get();
    expect(row?.instanceName).toBe('Original Name');
    expect(row?.hmacSecret).toBe('existing-secret');
  });

  it('writes null instance_name when body omits the field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'remote-secret',
      },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.instanceName).toBeNull();
  });
});

describe('POST /api/federation/peer/accept — response body carries instanceName', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings('Local Backspace');
    app = await buildApp();
  });

  it('returns our own instanceName in the response body on new-peer accept', async () => {
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
    const body = response.json() as { accepted: boolean; instanceName?: string | null };
    expect(body.accepted).toBe(true);
    expect(body.instanceName).toBe('Local Backspace');
  });

  it('returns our instanceName on the active refusal path too (409)', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-active',
      origin: 'https://remote.example',
      hmacSecret: 'existing-secret',
      status: 'active',
      instanceName: 'Original Name',
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'remote-secret',
        instanceName: 'Remote Backspace',
      },
    });

    // BUG-1a: honest 409 refusal still carries our own instanceName so the
    // initiator can surface a useful "reset required" message.
    expect(response.statusCode).toBe(409);
    const body = response.json() as { accepted: boolean; instanceName?: string | null };
    expect(body.instanceName).toBe('Local Backspace');
  });

  it('returns instanceName: null when instanceSettings table is empty', async () => {
    testDb.delete(schema.instanceSettings).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      payload: {
        sourceOrigin: 'https://remote.example',
        hmacSecret: 'remote-secret',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { accepted: boolean; instanceName?: string | null };
    expect(body.instanceName).toBeNull();
  });
});

describe('POST /api/federation/peer/accept — BUG-1a: honest 409 refusal for existing active/needs_attention peer', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings('Local Backspace');
    app = await buildApp();
  });

  it('returns 409 PEER_EXISTS_RESET_REQUIRED and keeps S0 when an active peer receives a different secret (matching epoch)', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-active',
      origin: 'https://caller.example',
      hmacSecret: 'S0',
      status: 'active',
      peerInstanceId: 'epoch-A',
      instanceName: 'Caller',
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      remoteAddress: '10.0.1.1', // isolate rate-limit bucket (endpoint is IP-keyed)
      payload: {
        sourceOrigin: 'https://caller.example',
        hmacSecret: 'S1-different',
        instanceId: 'epoch-A', // same epoch → no reset, pure idempotent refusal
      },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as {
      accepted: boolean;
      code: string;
      error: string;
      instanceName?: string | null;
      instanceId?: string | null;
      statusCode: number;
    };
    expect(body.accepted).toBe(false);
    expect(body.code).toBe('PEER_EXISTS_RESET_REQUIRED');
    expect(body.statusCode).toBe(409);
    expect(body.instanceName).toBe('Local Backspace');

    // Anti-hijack: stored secret unchanged, status unchanged (same epoch).
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-active')).get();
    expect(row?.hmacSecret).toBe('S0');
    expect(row?.status).toBe('active');
  });

  it('returns 409 and keeps S0 when instanceId is omitted (legacy caller, no epoch)', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-active',
      origin: 'https://caller.example',
      hmacSecret: 'S0',
      status: 'active',
      peerInstanceId: 'epoch-A',
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      remoteAddress: '10.0.1.2', // isolate rate-limit bucket (endpoint is IP-keyed)
      payload: {
        sourceOrigin: 'https://caller.example',
        hmacSecret: 'S1-different',
        // no instanceId → epoch-mismatch guard cannot fire
      },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as { code: string };
    expect(body.code).toBe('PEER_EXISTS_RESET_REQUIRED');

    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-active')).get();
    expect(row?.hmacSecret).toBe('S0');
    expect(row?.status).toBe('active');
  });

  it('epoch MISMATCH: fires markPeerReset (row → needs_attention) AND still returns 409 with S0 unchanged', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-active',
      origin: 'https://caller.example',
      hmacSecret: 'S0',
      status: 'active',
      peerInstanceId: 'epoch-A',
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      remoteAddress: '10.0.1.3', // isolate rate-limit bucket (endpoint is IP-keyed)
      payload: {
        sourceOrigin: 'https://caller.example',
        hmacSecret: 'S1-different',
        instanceId: 'epoch-B-new-incarnation', // differs from stored epoch-A
      },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as { code: string };
    expect(body.code).toBe('PEER_EXISTS_RESET_REQUIRED');

    // Detection still fires: row routed to needs_attention, observed epoch recorded,
    // but trusted baseline (peerInstanceId) and secret are NOT rekeyed.
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-active')).get();
    expect(row?.status).toBe('needs_attention');
    expect(row?.needsAttentionReason).toBe('peer_reset_detected');
    expect(row?.observedPeerInstanceId).toBe('epoch-B-new-incarnation');
    expect(row?.peerInstanceId).toBe('epoch-A');
    expect(row?.hmacSecret).toBe('S0');
  });

  it('existing needs_attention peer: same 409 refusal, secret unchanged', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-na',
      origin: 'https://caller.example',
      hmacSecret: 'S0',
      status: 'needs_attention',
      needsAttentionReason: 'peer_reset_detected',
      peerInstanceId: 'epoch-A',
      createdAt: Date.now(),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/accept',
      remoteAddress: '10.0.1.4', // isolate rate-limit bucket (endpoint is IP-keyed)
      payload: {
        sourceOrigin: 'https://caller.example',
        hmacSecret: 'S1-different',
        instanceId: 'epoch-A',
      },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as { code: string };
    expect(body.code).toBe('PEER_EXISTS_RESET_REQUIRED');

    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-na')).get();
    expect(row?.hmacSecret).toBe('S0');
    expect(row?.status).toBe('needs_attention');
  });
});

describe('POST /api/federation/peer/initiate — persists remote instanceName from handshake response', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings('Local Backspace');
    app = await buildApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes remote.instanceName when remote /peer/accept succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ accepted: true, instanceName: 'Remote Backspace' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: 'https://remote.example' },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.status).toBe('active');
    expect(row?.instanceName).toBe('Remote Backspace');
  });

  it('writes null instanceName when remote response omits the field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/peer/initiate',
      payload: { remoteOrigin: 'https://remote.example' },
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.instanceName).toBeNull();
  });
});

describe('POST /api/federation/approval-requests/:id/approve — persists remote instanceName from handshake response', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings('Local Backspace');
    app = await buildApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedApprovalRequest(): string {
    const id = 'approval-1';
    testDb.insert(schema.peerApprovalRequests).values({
      id,
      origin: 'https://remote.example',
      instanceName: 'Stale Name',
      hmacSecret: 'their-old-secret',
      requestedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    }).run();
    return id;
  }

  it('writes remote.instanceName when remote /peer/accept succeeds', async () => {
    const approvalId = seedApprovalRequest();

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ accepted: true, instanceName: 'Remote Backspace' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const response = await app.inject({
      method: 'POST',
      url: `/api/federation/approval-requests/${approvalId}/approve`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.status).toBe('active');
    expect(row?.instanceName).toBe('Remote Backspace');
  });

  it('writes null instanceName when remote response omits the field', async () => {
    const approvalId = seedApprovalRequest();

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const response = await app.inject({
      method: 'POST',
      url: `/api/federation/approval-requests/${approvalId}/approve`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.instanceName).toBeNull();
  });
});
