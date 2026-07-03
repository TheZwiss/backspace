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
import { signRequest, verifySignature } from '../utils/federationAuth.js';
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

function seedNativeUser(): void {
  testDb.insert(schema.users).values({
    id: 'native-1',
    username: 'youruser',
    displayName: null,
    passwordHash: 'x',
    status: 'offline',
    isAdmin: 0,
    isDeleted: 0,
    discoverable: 1,
    homeInstance: null,
    homeUserId: null,
    createdAt: 1,
  } as typeof schema.users.$inferInsert).run();
}

// Tokens are minted by /api/auth/attach-proof as randomBytes(32).toString('hex')
// — always 64 lowercase hex chars — so the fixture token must be valid hex too.
function seedProof(overrides: Partial<typeof schema.federationAttachProofs.$inferInsert> = {}): string {
  const token = 'a1'.repeat(32);
  testDb.insert(schema.federationAttachProofs).values({
    token,
    homeUserId: 'native-1',
    targetDomain: 'orbit.test',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    usedAt: null,
    ...overrides,
  }).run();
  return overrides.token ?? token;
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

async function verify(app: FastifyInstance, body: object) {
  const bodyStr = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/api/federation/verify-attach-proof',
    headers: signedHeaders(bodyStr),
    payload: bodyStr,
  });
}

describe('POST /api/federation/verify-attach-proof', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedActivePeer();
    seedNativeUser();
    app = await buildApp();
  });

  it('valid token → identity returned, marked used', async () => {
    const token = seedProof();
    const res = await verify(app, { token });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ valid: true, homeUserId: 'native-1', username: 'youruser' });
    const row = testDb.select().from(schema.federationAttachProofs).all()[0]!;
    expect(row.usedAt).not.toBeNull();
  });

  it('second verification of the same token → valid:false (single-use)', async () => {
    const token = seedProof();
    await verify(app, { token });
    const res = await verify(app, { token });
    expect(JSON.parse(res.body)).toEqual({ valid: false });
  });

  it('expired token → valid:false', async () => {
    const token = seedProof({ expiresAt: Date.now() - 1 });
    const res = await verify(app, { token });
    expect(JSON.parse(res.body)).toEqual({ valid: false });
  });

  it('token bound to a DIFFERENT target domain → valid:false (peer-domain binding)', async () => {
    const token = seedProof({ targetDomain: 'someone-else.test' });
    const res = await verify(app, { token });
    expect(JSON.parse(res.body)).toEqual({ valid: false });
  });

  it('unknown token → valid:false', async () => {
    const res = await verify(app, { token: 'f'.repeat(64) });
    expect(JSON.parse(res.body)).toEqual({ valid: false });
  });

  it('home user deleted after mint → valid:false', async () => {
    const token = seedProof();
    testDb.update(schema.users).set({ isDeleted: 1 }).where(eq(schema.users.id, 'native-1')).run();
    const res = await verify(app, { token });
    expect(JSON.parse(res.body)).toEqual({ valid: false });
  });

  it('home user no longer native (homeInstance set) after mint → valid:false', async () => {
    const token = seedProof();
    testDb.update(schema.users).set({ homeInstance: 'orbit.test' }).where(eq(schema.users.id, 'native-1')).run();
    const res = await verify(app, { token });
    expect(JSON.parse(res.body)).toEqual({ valid: false });
  });

  it('unsigned request → 401', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/federation/verify-attach-proof',
      headers: { 'Content-Type': 'application/json' }, payload: JSON.stringify({ token: 'x' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('response is HMAC-signed (epoch pattern)', async () => {
    const token = seedProof();
    const res = await verify(app, { token });
    const sig = res.headers['x-federation-signature'] as string;
    expect(sig).toMatch(/^sha256=/);
    const ts = res.headers['x-federation-timestamp'] as string;
    expect(ts).toBeDefined();
    const nonce = res.headers['x-federation-nonce'] as string;
    // Signature must verify against the response body with the shared secret.
    expect(verifySignature(res.body, sig.slice('sha256='.length), PEER_SECRET, Number(ts), nonce)).toBe(true);
  });
});
