import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToAdmins: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    forceDisconnectUser: vi.fn(),
    getAllOnlineUserIds: () => [],
  },
}));
// Each test acts as its own user, so the per-user rate limiter (module state)
// never carries a count from one test into the next.
vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string; headers: Record<string, string | string[] | undefined> }) => {
    const header = req.headers['x-test-user'];
    req.userId = typeof header === 'string' ? header : 'user-default';
  },
  requireAdmin: async () => { /* not exercised here */ },
}));
vi.mock('../utils/federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(async () => undefined),
  onPeerDeactivated: vi.fn(async () => undefined),
}));
vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://home.test' };
});

const PEERED = 'https://orbit.test';
const UNKNOWN = 'https://vault.test';

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedSettings(autoAcceptPeering: 0 | 1): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceName: 'Home',
    instanceId: 'home-epoch',
    autoAcceptPeering,
    registrationOpen: 1,
    updatedAt: Date.now(),
  } as typeof schema.instanceSettings.$inferInsert).run();
}

function seedUser(id: string): void {
  testDb.insert(schema.users).values({
    id, username: id, passwordHash: 'x', status: 'online', isAdmin: 0, createdAt: Date.now(),
  } as typeof schema.users.$inferInsert).run();
}

function seedPeer(origin: string, status: 'active' | 'unreachable' | 'awaiting_approval' | 'rejected'): void {
  testDb.insert(schema.federationPeers).values({
    id: `peer-${origin}`, origin, hmacSecret: 'secret', status, initiatedBy: 'admin', createdAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('./federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  sqlite.close();
});

async function ensure(user: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/federation/peer/ensure',
    headers: { 'content-type': 'application/json', 'x-test-user': user },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('POST /api/federation/peer/ensure — the rate limit only counts calls that can start a handshake', () => {
  // A client asks on every session it opens (connect, login, token resume, and
  // once per connection at app start). A peering that is already settled costs
  // nothing to confirm, so confirming it must not use up the allowance the
  // one new connection that does need a handshake depends on.
  it('confirms an active peering as often as it is asked', async () => {
    seedSettings(1);
    seedUser('u-active');
    seedPeer(PEERED, 'active');

    for (let i = 0; i < 6; i++) {
      const res = await ensure('u-active', { remoteOrigin: PEERED });
      expect(res.status).toBe(200);
      expect(res.body.peeringStatus).toBe('active');
    }
  });

  it('still answers a new origin after several settled confirmations', async () => {
    seedSettings(0);
    seedUser('u-mixed');
    seedPeer(PEERED, 'active');

    for (let i = 0; i < 4; i++) {
      expect((await ensure('u-mixed', { remoteOrigin: PEERED })).status).toBe(200);
    }
    const fresh = await ensure('u-mixed', { remoteOrigin: UNKNOWN });
    expect(fresh.status).toBe(200);
    expect(fresh.body.peeringStatus).toBe('admin_required');
  });

  it('POSITIVE CONTROL: still limits calls that reach the handshake path', async () => {
    seedSettings(0);
    seedUser('u-limited');

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await ensure('u-limited', { remoteOrigin: UNKNOWN })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('POST /api/federation/peer/ensure — the reason the local admin is shown', () => {
  // With auto-accept off, the call queues an outbound approval request and a
  // subscriber row per user. The admin's queue and the user's pending list
  // are rendered from that row's reason and target.
  function subscribers(): Array<{ triggerReason: string; triggerTarget: string }> {
    return testDb
      .select({
        triggerReason: schema.peerApprovalSubscribers.triggerReason,
        triggerTarget: schema.peerApprovalSubscribers.triggerTarget,
      })
      .from(schema.peerApprovalSubscribers)
      .all();
  }

  beforeEach(() => {
    seedSettings(0);
  });

  it('records a connection as instance_connect, with the origin as its target', async () => {
    seedUser('u-connect');
    const res = await ensure('u-connect', { remoteOrigin: UNKNOWN, reason: 'instance_connect' });

    expect(res.status).toBe(200);
    expect(res.body.peeringStatus).toBe('admin_required');
    expect(subscribers()).toEqual([{ triggerReason: 'instance_connect', triggerTarget: UNKNOWN }]);
  });

  it('reads a request with no reason, from a client that predates it, as a connection and never as a friend add', async () => {
    seedUser('u-legacy');
    const res = await ensure('u-legacy', { remoteOrigin: UNKNOWN });

    expect(res.status).toBe(200);
    expect(subscribers()).toEqual([{ triggerReason: 'instance_connect', triggerTarget: UNKNOWN }]);
  });

  it.each([
    ['friend_add, which only the server-side friend-add path may state', 'friend_add'],
    ['a reason no client caller exists for', 'space_join'],
    ['an unknown reason', 'bogus'],
    ['a reason that is not a string', 42],
  ])('refuses %s', async (_label, reason) => {
    seedUser('u-refused');
    const res = await ensure('u-refused', { remoteOrigin: UNKNOWN, reason });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
    expect(subscribers()).toEqual([]);
  });
});
