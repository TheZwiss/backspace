import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { hashPassword } from '../utils/auth.js';
import { setWorkerId } from '../utils/snowflake.js';
import { buildFederationHeaders } from '../utils/federationAuth.js';

setWorkerId(2);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level mutable state — mirrors auth.test.ts: the getDb mock closes over
// a getter so each beforeEach can swap in a fresh in-memory DB.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
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

async function buildApp(): Promise<FastifyInstance> {
  const { authRoutes } = await import('./auth.js');
  const f = Fastify();
  await f.register(authRoutes);
  return f;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  app = await buildApp();
});

describe('login: federation_home_orphaned freeze', () => {
  it('rejects login for a frozen (orphaned) federated account even with the correct password', async () => {
    // Seed a real federated account with a known password, then freeze it.
    const passwordHash = await hashPassword('correct-horse');
    testDb.insert(schema.users).values({
      id: 'user-frozen-1',
      username: 'carol@orbit.ddns.net',
      passwordHash,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'old-home-id',
      federationHomeOrphaned: 1,
      avatarColor: '#fff',
      createdAt: Date.now(),
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'carol@orbit.ddns.net', password: 'correct-horse' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Invalid username or password');
  });

  it('allows login for a non-frozen federated account with the correct password (freeze is targeted)', async () => {
    // Control: same shape, but federationHomeOrphaned = 0 must authenticate,
    // proving the freeze targets the flag rather than all federated accounts.
    const passwordHash = await hashPassword('correct-horse');
    testDb.insert(schema.users).values({
      id: 'user-ok-1',
      username: 'dave@orbit.ddns.net',
      passwordHash,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'live-home-id',
      federationHomeOrphaned: 0,
      avatarColor: '#fff',
      createdAt: Date.now(),
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'dave@orbit.ddns.net', password: 'correct-horse' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });
});

describe('login: self-heal epoch guard', () => {
  // The self-heal path re-hashes a federated user's stale local password when the
  // home instance accepts it. The epoch guard (§6.3a) gates that re-hash on the
  // home's CURRENT instance epoch matching the trusted baseline we recorded, so a
  // factory-reset home (new incarnation, same domain) cannot silently hand an
  // established account to a new same-name user via self-heal.
  //
  // globalThis.fetch is stubbed to route the two outbound POSTs the login handler
  // makes: the home /api/auth/login probe (→ 200 {ok}) and the subsequent
  // fetchPeerEpoch call to /api/federation/epoch (→ signed {instanceId} or 404).
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  // Seed a federated user whose LOCAL hash is stale (does not match the test
  // password) plus an active peer row carrying `baselineEpoch` as its recorded
  // baseline (null → no baseline on record).
  async function seedStaleUserAndPeer(baselineEpoch: string | null, hmacSecret: string): Promise<void> {
    const staleHash = await hashPassword('OLD-password-not-this');
    testDb.insert(schema.users).values({
      id: 'user-c',
      username: 'carol@orbit.ddns.net',
      passwordHash: staleHash,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'hid',
      avatarColor: '#fff',
      createdAt: Date.now(),
    }).run();
    testDb.insert(schema.federationPeers).values({
      id: 'peer-k',
      origin: 'https://orbit.ddns.net',
      hmacSecret,
      status: 'active',
      peerInstanceId: baselineEpoch,
      createdAt: Date.now(),
    }).run();
  }

  // home-login POST → {ok:true}; /api/federation/epoch → signed {instanceId} (or
  // 404 when `epochToEcho` is null, exercising the fail-closed "cannot determine"
  // branch). The epoch response is HMAC-signed exactly as a real peer would sign
  // it, so it round-trips through fetchPeerEpoch's real signature verification.
  function makeFetchStub(hmacSecret: string, epochToEcho: string | null): typeof globalThis.fetch {
    return (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.endsWith('/api/auth/login')) {
        return new Response(JSON.stringify({ token: 't', user: {} }), { status: 200 });
      }
      if (u.endsWith('/api/federation/epoch')) {
        if (epochToEcho === null) return new Response('nope', { status: 404 });
        const body = JSON.stringify({ instanceId: epochToEcho });
        const headers = buildFederationHeaders(body, hmacSecret, 'https://our.origin');
        return new Response(body, { status: 200, headers });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof globalThis.fetch;
  }

  it('MATCH → self-heal allowed (login 200)', async () => {
    const secret = 'shared-secret-abc';
    await seedStaleUserAndPeer('EPOCH-A', secret);
    globalThis.fetch = makeFetchStub(secret, 'EPOCH-A'); // home echoes the SAME epoch

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'carol@orbit.ddns.net', password: 'the-real-current-password' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('DIFFERS → self-heal refused (login 401)', async () => {
    const secret = 'shared-secret-abc';
    await seedStaleUserAndPeer('EPOCH-A', secret);
    globalThis.fetch = makeFetchStub(secret, 'EPOCH-B'); // reset home echoes a NEW epoch

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'carol@orbit.ddns.net', password: 'attacker-password' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('CANNOT DETERMINE (404 / desynced secret) → fail closed (login 401)', async () => {
    const secret = 'shared-secret-abc';
    await seedStaleUserAndPeer('EPOCH-A', secret);
    globalThis.fetch = makeFetchStub(secret, null); // epoch endpoint 404 → null

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'carol@orbit.ddns.net', password: 'whatever' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('NO BASELINE (peerInstanceId null) → legacy allow (login 200)', async () => {
    const secret = 'shared-secret-abc';
    await seedStaleUserAndPeer(null, secret); // no baseline on record

    globalThis.fetch = makeFetchStub(secret, 'EPOCH-A');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'carol@orbit.ddns.net', password: 'the-real-current-password' },
    });

    expect(res.statusCode).toBe(200);
  });
});
