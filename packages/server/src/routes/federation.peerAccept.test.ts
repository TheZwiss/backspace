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

  it('does NOT overwrite instance_name on the active idempotent early-return path', async () => {
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

    expect(response.statusCode).toBe(200);
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

  it('returns our instanceName on the active idempotent path too', async () => {
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

    expect(response.statusCode).toBe(200);
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
