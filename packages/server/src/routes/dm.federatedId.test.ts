import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
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
let currentUserId = 'user-A';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
  },
}));

vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    isFederationRelayEnabled: () => true,
    queueDmCloseRelay: vi.fn(),
    sendTypingRelay: vi.fn(),
    queueDmRelay: vi.fn(),
    queueOutboxEvent: vi.fn(),
    appendMutationLog: vi.fn(),
  };
});

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

function seedTwoUsers(): void {
  testDb.insert(schema.users).values({
    id: 'user-A',
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'x',
    homeUserId: 'user-A',
    homeInstance: 'https://local.example',
    createdAt: Date.now(),
  }).run();

  testDb.insert(schema.users).values({
    id: 'user-B',
    username: 'bob',
    displayName: 'Bob',
    passwordHash: 'x',
    homeUserId: 'remote-bob',
    homeInstance: 'https://remote.example',
    createdAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { dmRoutes } = await import('./dm.js');
  await app.register(dmRoutes);
  await app.ready();
  return app;
}

describe('POST /api/dm — idempotent existing DM response includes federatedId', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedTwoUsers();
    currentUserId = 'user-A';
    app = await buildApp();
  });

  it('fresh-create returns a federatedId for federated 1-on-1 DM', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/dm',
      payload: { userId: 'user-B' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; federatedId: string | null };
    expect(body.federatedId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('idempotent existing-DM path returns the same federatedId field', async () => {
    // First call creates the DM
    const first = await app.inject({
      method: 'POST',
      url: '/api/dm',
      payload: { userId: 'user-B' },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { id: string; federatedId: string | null };
    const expectedFederatedId = firstBody.federatedId;
    expect(expectedFederatedId).toMatch(/^[a-f0-9]{32}$/);

    // Second call returns the existing DM idempotently — must carry federatedId
    const second = await app.inject({
      method: 'POST',
      url: '/api/dm',
      payload: { userId: 'user-B' },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { id: string; federatedId: string | null };

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.federatedId).toBe(expectedFederatedId);
  });
});
