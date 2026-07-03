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

describe('POST /api/federation/peers/:id/recheck', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    app = await buildApp();
  });
  afterEach(async () => { await app.close(); });

  function seedUnreachable(id: string): void {
    testDb.insert(schema.federationPeers).values({
      id, origin: 'https://peer.example', hmacSecret: 'secret',
      status: 'unreachable', consecutiveFailures: 10, probeAttempts: 2, lastProbeAt: 1,
      lastSyncedAt: Date.now(), createdAt: Date.now(),
    }).run();
  }

  it('returns 400 for a non-unreachable peer', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'p-active', origin: 'https://peer.example', hmacSecret: 'secret',
      status: 'active', lastSyncedAt: Date.now(), createdAt: Date.now(),
    }).run();
    const res = await app.inject({ method: 'POST', url: '/api/federation/peers/p-active/recheck' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown peer', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/federation/peers/nope/recheck' });
    expect(res.statusCode).toBe(404);
  });

  it('recovers the peer when the probe succeeds', async () => {
    seedUnreachable('p-rec');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await app.inject({ method: 'POST', url: '/api/federation/peers/p-rec/recheck' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recovered: true, status: 'active' });
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'p-rec')).get()!;
    expect(row.status).toBe('active');
  });

  it('stays unreachable and advances pacing when the probe fails', async () => {
    seedUnreachable('p-fail');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const res = await app.inject({ method: 'POST', url: '/api/federation/peers/p-fail/recheck' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recovered: false, status: 'unreachable' });
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'p-fail')).get()!;
    expect(row.probeAttempts).toBe(3);
    expect(row.lastProbeAt).toBeGreaterThan(1);
  });
});
