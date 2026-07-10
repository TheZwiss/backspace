import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as schema from '../../../db/schema.js';
import { setWorkerId } from '../../../utils/snowflake.js';
import { signRequest } from '../../../utils/federationAuth.js';
import type { S2SAuthOptions } from './s2sAuth.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level mutable state. Each beforeEach reassigns sqlite/testDb;
// the getDb getter in the mock closes over the current binding.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const PEER_ORIGIN = 'https://orbit.test';
const PEER_SECRET = 'a'.repeat(64);

vi.mock('../../../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

// Wrap verifyPeerSignature in a passthrough spy so ordering (rate-limit BEFORE
// signature) can be asserted by call count while real HMAC verification still runs.
const { verifySpy } = vi.hoisted(() => ({ verifySpy: vi.fn() }));
vi.mock('../../../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../utils/federationAuth.js')>();
  verifySpy.mockImplementation(actual.verifyPeerSignature);
  return {
    ...actual,
    verifyPeerSignature: (...args: Parameters<typeof actual.verifyPeerSignature>) => verifySpy(...args),
  };
});

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedPeer(status = 'active', nonceSupported = 0): void {
  testDb.insert(schema.federationPeers).values({
    id: 'peer-1',
    origin: PEER_ORIGIN,
    hmacSecret: PEER_SECRET,
    status,
    nonceSupported,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    consecutiveFailures: 0,
    consecutiveAuthFailures: 0,
  } as typeof schema.federationPeers.$inferInsert).run();
}

// Build a tiny app whose sole route drives authenticateS2SPeer and echoes the
// result. `authOpts` is injected verbatim so the rate-limiter (an injectable
// plain object) and log flags can be controlled per test.
async function buildApp(authOpts: S2SAuthOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { authenticateS2SPeer } = await import('./s2sAuth.js');
  app.post('/probe', async (request, reply) => {
    const result = authenticateS2SPeer(request, reply, authOpts);
    if (!result.ok) return; // a reply was already sent
    return reply.code(200).send({
      ok: true,
      peerOrigin: result.peer.origin,
      nonce: result.nonce,
    });
  });
  await app.ready();
  return app;
}

/** Signed headers WITH a nonce (default valid path). */
function signedHeaders(body: string, nonce: string = randomUUID()): Record<string, string> {
  const timestamp = Date.now();
  const sig = signRequest(body, PEER_SECRET, timestamp, nonce);
  return {
    'X-Federation-Origin': PEER_ORIGIN,
    'X-Federation-Timestamp': String(timestamp),
    'X-Federation-Nonce': nonce,
    'X-Federation-Signature': `sha256=${sig}`,
    'Content-Type': 'application/json',
  };
}

/** Signed headers WITHOUT a nonce (legacy peer form: sign `${ts}.${body}`). */
function signedHeadersNoNonce(body: string): Record<string, string> {
  const timestamp = Date.now();
  const sig = signRequest(body, PEER_SECRET, timestamp, null);
  return {
    'X-Federation-Origin': PEER_ORIGIN,
    'X-Federation-Timestamp': String(timestamp),
    'X-Federation-Signature': `sha256=${sig}`,
    'Content-Type': 'application/json',
  };
}

async function probe(app: FastifyInstance, headers: Record<string, string>, body: object = {}) {
  return app.inject({ method: 'POST', url: '/probe', headers, payload: JSON.stringify(body) });
}

describe('authenticateS2SPeer', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    verifySpy.mockClear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    sqlite.close();
  });

  it('missing/invalid federation headers → 401 (helper never emits /epoch\'s 400)', async () => {
    seedPeer('active');
    const app = await buildApp();
    const res = await probe(app, { 'Content-Type': 'application/json' }, { hello: 'world' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Missing or malformed federation headers', statusCode: 401 });
    // Guard against the non-adopter /epoch's 400: the shared helper is 401-only here.
    expect(res.statusCode).not.toBe(400);
  });

  it('peer not found → 403 with exact body', async () => {
    // No peer seeded.
    const app = await buildApp();
    const body = { hello: 'world' };
    const res = await probe(app, signedHeaders(JSON.stringify(body)), body);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unknown or inactive peer', statusCode: 403 });
  });

  it('peer present but non-active status → 403 with exact body', async () => {
    seedPeer('needs_attention');
    const app = await buildApp();
    const body = { hello: 'world' };
    const res = await probe(app, signedHeaders(JSON.stringify(body)), body);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unknown or inactive peer', statusCode: 403 });
  });

  it('rate-limited WITH retryAfterSeconds → 429 + Retry-After header', async () => {
    seedPeer('active');
    const app = await buildApp({ rateLimiter: { limited: () => true, retryAfterSeconds: 60 } });
    const body = { hello: 'world' };
    const res = await probe(app, signedHeaders(JSON.stringify(body)), body);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(JSON.parse(res.body)).toEqual({ error: 'Rate limit exceeded', statusCode: 429 });
  });

  it('rate-limited WITHOUT retryAfterSeconds → 429, no Retry-After header', async () => {
    seedPeer('active');
    const app = await buildApp({ rateLimiter: { limited: () => true } });
    const body = { hello: 'world' };
    const res = await probe(app, signedHeaders(JSON.stringify(body)), body);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ error: 'Rate limit exceeded', statusCode: 429 });
  });

  it('rate-limit fires BEFORE signature verification (verifyPeerSignature not reached)', async () => {
    seedPeer('active');
    const app = await buildApp({ rateLimiter: { limited: () => true, retryAfterSeconds: 60 } });
    // Deliberately BAD signature: if signature ran first we would see 401, not 429.
    const headers = signedHeaders(JSON.stringify({ hello: 'world' }));
    headers['X-Federation-Signature'] = 'sha256=' + 'f'.repeat(64);
    const res = await probe(app, headers, { hello: 'world' });
    expect(res.statusCode).toBe(429);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('bad signature → 401 with exact body', async () => {
    seedPeer('active');
    const app = await buildApp();
    const headers = signedHeaders(JSON.stringify({ hello: 'world' }));
    headers['X-Federation-Signature'] = 'sha256=' + 'f'.repeat(64);
    const res = await probe(app, headers, { hello: 'world' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid signature', statusCode: 401 });
  });

  it('duplicate nonce → 409 with exact body', async () => {
    seedPeer('active');
    const app = await buildApp();
    const body = { hello: 'world' };
    const nonce = 'dup-nonce-fixed-1';
    // First request records the nonce and passes.
    const first = await probe(app, signedHeaders(JSON.stringify(body), nonce), body);
    expect(first.statusCode).toBe(200);
    // Second request with the SAME nonce is a replay.
    const second = await probe(app, signedHeaders(JSON.stringify(body), nonce), body);
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body)).toEqual({ error: 'Duplicate nonce — possible replay', statusCode: 409 });
  });

  it('nonce missing + peer SUPPORTS nonce → 401 with exact body', async () => {
    seedPeer('active', 1); // nonceSupported = 1
    const app = await buildApp();
    const body = { hello: 'world' };
    const res = await probe(app, signedHeadersNoNonce(JSON.stringify(body)), body);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Nonce required — peer previously supported nonces', statusCode: 401 });
  });

  it('nonce missing + peer does NOT support nonce → passes; logMissingNonce=true warns', async () => {
    seedPeer('active', 0);
    const app = await buildApp({ logMissingNonce: true });
    const body = { hello: 'world' };
    const res = await probe(app, signedHeadersNoNonce(JSON.stringify(body)), body);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, peerOrigin: PEER_ORIGIN, nonce: null });
    expect(warnSpy).toHaveBeenCalledWith(
      `[federation] Peer ${PEER_ORIGIN} does not support replay protection (no nonce)`,
    );
  });

  it('nonce missing + peer does NOT support nonce → passes; logMissingNonce=false stays silent', async () => {
    seedPeer('active', 0);
    const app = await buildApp({ logMissingNonce: false });
    const body = { hello: 'world' };
    const res = await probe(app, signedHeadersNoNonce(JSON.stringify(body)), body);
    expect(res.statusCode).toBe(200);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logContext appends the endpoint suffix to the missing-nonce warn (sync parity)', async () => {
    seedPeer('active', 0);
    const app = await buildApp({ logMissingNonce: true, logContext: 'sync' });
    const body = { hello: 'world' };
    const res = await probe(app, signedHeadersNoNonce(JSON.stringify(body)), body);
    expect(res.statusCode).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      `[federation] Peer ${PEER_ORIGIN} does not support replay protection (no nonce) [sync]`,
    );
  });

  it('success → { ok:true, peer, nonce } with the parsed nonce', async () => {
    seedPeer('active');
    const app = await buildApp();
    const body = { hello: 'world' };
    const nonce = 'success-nonce-1';
    const res = await probe(app, signedHeaders(JSON.stringify(body), nonce), body);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, peerOrigin: PEER_ORIGIN, nonce });
  });

  it('success with a rate-limiter that is under the cap → passes through', async () => {
    seedPeer('active');
    const app = await buildApp({ rateLimiter: { limited: () => false, retryAfterSeconds: 60 } });
    const body = { hello: 'world' };
    const res = await probe(app, signedHeaders(JSON.stringify(body)), body);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
