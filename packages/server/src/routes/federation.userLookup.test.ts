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
import { signRequest } from '../utils/federationAuth.js';
import { randomUUID } from 'node:crypto';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level mutable state. Each beforeEach reassigns sqlite/testDb;
// the getDb getter in the mock closes over the current binding.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const PEER_ORIGIN = 'https://orbit.test';
const PEER_SECRET = 'a'.repeat(64);

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://home.test' };
});

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

function seedActivePeer(): void {
  testDb.insert(schema.federationPeers).values({
    id: 'peer-1',
    origin: PEER_ORIGIN,
    hmacSecret: PEER_SECRET,
    status: 'active',
    nonceSupported: 1,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    consecutiveFailures: 0,
    consecutiveAuthFailures: 0,
  } as typeof schema.federationPeers.$inferInsert).run();
}

function seedUser(opts: {
  id: string;
  username: string;
  isDeleted?: 0 | 1;
  discoverable?: 0 | 1;
  homeInstance?: string | null;
  homeUserId?: string | null;
  displayName?: string | null;
  avatar?: string | null;
  avatarColor?: string | null;
  banner?: string | null;
  bio?: string | null;
}): void {
  testDb.insert(schema.users).values({
    id: opts.id,
    username: opts.username,
    displayName: opts.displayName ?? null,
    passwordHash: 'x',
    status: 'offline',
    isAdmin: 0,
    isDeleted: opts.isDeleted ?? 0,
    discoverable: opts.discoverable ?? 1,
    homeInstance: opts.homeInstance ?? null,
    homeUserId: opts.homeUserId ?? null,
    avatar: opts.avatar ?? null,
    avatarColor: opts.avatarColor ?? null,
    banner: opts.banner ?? null,
    bio: opts.bio ?? null,
    createdAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { _resetLookupRateBuckets, federationRoutes } = await import('./federation.js');
  _resetLookupRateBuckets();
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

function signedHeaders(body: string): Record<string, string> {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const sig = signRequest(body, PEER_SECRET, timestamp, nonce);
  return {
    'X-Federation-Origin': PEER_ORIGIN,
    'X-Federation-Timestamp': String(timestamp),
    'X-Federation-Nonce': nonce,
    'X-Federation-Signature': `sha256=${sig}`,
    'Content-Type': 'application/json',
  };
}

async function lookup(
  app: FastifyInstance,
  body: object,
  headersOverride?: Record<string, string>,
) {
  const bodyStr = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/api/federation/users/lookup',
    headers: headersOverride ?? signedHeaders(bodyStr),
    payload: bodyStr,
  });
}

describe('POST /api/federation/users/lookup', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedActivePeer();
    app = await buildApp();
  });

  it('returns 200 + full profile snapshot for a native user', async () => {
    seedUser({ id: 'u1', username: 'alice', displayName: 'Alice', bio: 'hi', avatarColor: '#ff0000' });
    const res = await lookup(app, { username: 'alice' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.found).toBe(true);
    expect(body.user.homeUserId).toBe('u1');
    expect(body.user.username).toBe('alice');
    expect(body.user.profile.displayName).toBe('Alice');
    expect(body.user.profile.bio).toBe('hi');
    expect(body.user.profile.avatarColor).toBe('#ff0000');
  });

  it('returns 200 for a discoverable=0 user (exact-handle resolution must not regress)', async () => {
    seedUser({ id: 'u1', username: 'alice', discoverable: 0 });
    const res = await lookup(app, { username: 'alice' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).found).toBe(true);
  });

  it('returns 404 for a tombstoned user', async () => {
    seedUser({ id: 'u1', username: 'alice', isDeleted: 1 });
    const res = await lookup(app, { username: 'alice' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ found: false, code: 'user_not_found' });
  });

  it('returns 404 for a replicated stub (homeInstance set)', async () => {
    seedUser({
      id: 'stub1',
      username: 'remote-id@orbit.test',
      homeInstance: 'orbit.test',
      homeUserId: 'remote-id',
    });
    const res = await lookup(app, { username: 'remote-id@orbit.test' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ found: false, code: 'user_not_found' });
  });

  it('returns 404 for an unknown username', async () => {
    const res = await lookup(app, { username: 'nope' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ found: false, code: 'user_not_found' });
  });

  it('matches lowercase storage from a mixed-case lookup', async () => {
    seedUser({ id: 'u1', username: 'alice' });
    const res = await lookup(app, { username: 'ALICE' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).found).toBe(true);
  });

  it('trims whitespace from the lookup username', async () => {
    seedUser({ id: 'u1', username: 'alice' });
    const res = await lookup(app, { username: '  alice  ' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).found).toBe(true);
  });

  it('returns 400 for a missing username field', async () => {
    const res = await lookup(app, {});
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('username');
  });

  it('returns 400 for a non-string username', async () => {
    const res = await lookup(app, { username: 42 });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('username');
  });

  it('returns 400 for a whitespace-only username', async () => {
    const res = await lookup(app, { username: '   ' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('username');
  });

  it('returns 401 when HMAC headers are missing', async () => {
    const res = await lookup(app, { username: 'alice' }, { 'Content-Type': 'application/json' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a bad signature', async () => {
    seedUser({ id: 'u1', username: 'alice' });
    // Sign a different body — mismatch will fail HMAC verification
    const bad = signedHeaders('{"different":"body"}');
    const res = await lookup(app, { username: 'alice' }, bad);
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 if the peer is not active', async () => {
    testDb
      .update(schema.federationPeers)
      .set({ status: 'rejected' })
      .where(eq(schema.federationPeers.id, 'peer-1'))
      .run();
    const res = await lookup(app, { username: 'alice' });
    expect(res.statusCode).toBe(403);
  });

  it('returns 429 after 60 lookups in a minute from the same peer', async () => {
    seedUser({ id: 'u1', username: 'alice' });
    for (let i = 0; i < 60; i++) {
      const ok = await lookup(app, { username: 'alice' });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await lookup(app, { username: 'alice' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
  });
});
