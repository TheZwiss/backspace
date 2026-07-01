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
import { buildFederationHeaders, verifySignature } from './federationAuth.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

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
    // epoch endpoint is HMAC-authenticated, not JWT
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

const LOCAL_EPOCH = 'local-epoch-abcd';
const PEER_ORIGIN = 'https://remote.example';
const PEER_SECRET = 'peer-shared-secret-0123456789abcdef';

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

function seedEpoch(instanceId: string): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceId,
    updatedAt: Date.now(),
  } as typeof schema.instanceSettings.$inferInsert).run();
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  const { __resetInstanceIdCacheForTest } = await import('./federationEpoch.js');
  __resetInstanceIdCacheForTest();
});

describe('getInstanceId', () => {
  it('returns the persisted epoch', async () => {
    seedEpoch('123e4567-e89b-12d3-a456-426614174000');
    const { getInstanceId } = await import('./federationEpoch.js');
    const id = getInstanceId();
    expect(id).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('caches the value after the first read', async () => {
    seedEpoch('123e4567-e89b-12d3-a456-426614174000');
    const { getInstanceId } = await import('./federationEpoch.js');
    expect(getInstanceId()).toBe('123e4567-e89b-12d3-a456-426614174000');

    // Mutate the underlying row; a cached reader must NOT observe the change.
    testDb.update(schema.instanceSettings)
      .set({ instanceId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })
      .run();
    expect(getInstanceId()).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('re-reads after __resetInstanceIdCacheForTest clears the cache', async () => {
    seedEpoch('123e4567-e89b-12d3-a456-426614174000');
    const { getInstanceId, __resetInstanceIdCacheForTest } = await import('./federationEpoch.js');
    expect(getInstanceId()).toBe('123e4567-e89b-12d3-a456-426614174000');

    testDb.update(schema.instanceSettings)
      .set({ instanceId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })
      .run();
    __resetInstanceIdCacheForTest();
    expect(getInstanceId()).toBe('ffffffff-ffff-ffff-ffff-ffffffffffff');
  });

  it('throws when the epoch is unset (invariant: ensureDefaults must run first)', async () => {
    // No row seeded — instance_settings is empty.
    const { getInstanceId } = await import('./federationEpoch.js');
    expect(() => getInstanceId()).toThrow(/instance_id is not set/);
  });
});

function seedInstanceSettings(instanceId: string): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceName: 'Local Backspace',
    instanceId,
    autoAcceptPeering: 1,
    registrationOpen: 1,
    updatedAt: Date.now(),
  } as typeof schema.instanceSettings.$inferInsert).run();
}

function seedActivePeer(): void {
  testDb.insert(schema.federationPeers).values({
    id: 'peer-remote',
    origin: PEER_ORIGIN,
    hmacSecret: PEER_SECRET,
    status: 'active',
    createdAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('../routes/federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

describe('POST /api/federation/epoch — signed request + signed response', () => {
  // The module-level beforeEach already created a fresh in-memory DB and reset
  // the instance-id cache; here we only seed rows and build the app.
  let app: FastifyInstance;

  beforeEach(async () => {
    seedInstanceSettings(LOCAL_EPOCH);
    seedActivePeer();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('returns 200 with a signed { instanceId } for a validly-signed request', async () => {
    const body = JSON.stringify({});
    const headers = buildFederationHeaders(body, PEER_SECRET, PEER_ORIGIN);

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/epoch',
      headers,
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const parsed = response.json() as { instanceId?: string };
    expect(parsed.instanceId).toBe(LOCAL_EPOCH);

    // The response body must be HMAC-signed with the peer's shared secret.
    const sigHeader = response.headers['x-federation-signature'] as string | undefined;
    const tsHeader = response.headers['x-federation-timestamp'] as string | undefined;
    const nonceHeader = response.headers['x-federation-nonce'] as string | undefined;
    expect(sigHeader).toMatch(/^sha256=/);
    expect(tsHeader).toBeTruthy();
    expect(nonceHeader).toBeTruthy();

    const sig = (sigHeader ?? '').replace(/^sha256=/, '');
    const ts = Number(tsHeader);
    const ok = verifySignature(response.body, sig, PEER_SECRET, ts, nonceHeader ?? null);
    expect(ok).toBe(true);
  });

  it('returns 400 when federation headers are missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/epoch',
      payload: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 401 when the request is signed with the wrong secret', async () => {
    const body = JSON.stringify({});
    const headers = buildFederationHeaders(body, 'the-wrong-secret', PEER_ORIGIN);

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/epoch',
      headers,
      payload: body,
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 403 for an origin that is not a known peer', async () => {
    const body = JSON.stringify({});
    const headers = buildFederationHeaders(body, PEER_SECRET, 'https://stranger.example');

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/epoch',
      headers,
      payload: body,
    });

    expect(response.statusCode).toBe(403);
  });

  it('returns 403 for a revoked peer', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-revoked',
      origin: 'https://revoked.example',
      hmacSecret: 'revoked-secret',
      status: 'revoked',
      createdAt: Date.now(),
    }).run();

    const body = JSON.stringify({});
    const headers = buildFederationHeaders(body, 'revoked-secret', 'https://revoked.example');

    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/epoch',
      headers,
      payload: body,
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('fetchPeerEpoch — signs request, verifies signed response, fails safe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function signedEpochResponse(instanceId: string, secret: string): Response {
    const responseBody = JSON.stringify({ instanceId });
    // buildFederationHeaders returns a complete Record<string,string> (signature,
    // timestamp, nonce, origin, content-type) — exactly what the real handler sets.
    const sigHeaders = buildFederationHeaders(responseBody, secret, PEER_ORIGIN);
    return new Response(responseBody, { status: 200, headers: sigHeaders });
  }

  it('returns the instanceId when the response signature is valid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => signedEpochResponse('remote-epoch-1', PEER_SECRET)));
    const { fetchPeerEpoch } = await import('./federationEpoch.js');
    const result = await fetchPeerEpoch({ origin: PEER_ORIGIN, hmacSecret: PEER_SECRET });
    expect(result).toBe('remote-epoch-1');
  });

  it('signs the outbound request with the peer secret', async () => {
    const fetchMock = vi.fn(async () => signedEpochResponse('remote-epoch-1', PEER_SECRET));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPeerEpoch } = await import('./federationEpoch.js');
    await fetchPeerEpoch({ origin: PEER_ORIGIN, hmacSecret: PEER_SECRET });

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`${PEER_ORIGIN}/api/federation/epoch`);
    const sentHeaders = call[1].headers as Record<string, string>;
    const sig = (sentHeaders['X-Federation-Signature'] ?? '').replace(/^sha256=/, '');
    const ts = Number(sentHeaders['X-Federation-Timestamp']);
    const nonce = sentHeaders['X-Federation-Nonce'] ?? null;
    expect(verifySignature(call[1].body as string, sig, PEER_SECRET, ts, nonce)).toBe(true);
  });

  it('returns null when the response signature is invalid (wrong secret)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => signedEpochResponse('remote-epoch-1', 'a-different-secret')));
    const { fetchPeerEpoch } = await import('./federationEpoch.js');
    const result = await fetchPeerEpoch({ origin: PEER_ORIGIN, hmacSecret: PEER_SECRET });
    expect(result).toBeNull();
  });

  it('returns null on 404 (peer not yet upgraded)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })));
    const { fetchPeerEpoch } = await import('./federationEpoch.js');
    const result = await fetchPeerEpoch({ origin: PEER_ORIGIN, hmacSecret: PEER_SECRET });
    expect(result).toBeNull();
  });

  it('returns null on a network error (no throw escapes)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const { fetchPeerEpoch } = await import('./federationEpoch.js');
    const result = await fetchPeerEpoch({ origin: PEER_ORIGIN, hmacSecret: PEER_SECRET });
    expect(result).toBeNull();
  });

  it('returns null when the response omits the signature header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ instanceId: 'remote-epoch-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));
    const { fetchPeerEpoch } = await import('./federationEpoch.js');
    const result = await fetchPeerEpoch({ origin: PEER_ORIGIN, hmacSecret: PEER_SECRET });
    expect(result).toBeNull();
  });
});

describe('refreshPeerEpochs — deterministic populate-if-null baseline (self-terminating)', () => {
  // Drives the REAL refreshPeerEpochs → fetchPeerEpoch → verifySignature round-trip.
  // fetchPeerEpoch is deliberately NOT stubbed: a signing/arg-order mismatch must
  // fail these assertions loudly rather than degrade to a silent null (which would
  // masquerade as a benign 404 and quietly disable the whole refresh).
  beforeEach(() => {
    // Local instance epoch must be readable (getOurOrigin does not need it, but the
    // module is shared; seed for parity with real boot state).
    seedInstanceSettings(LOCAL_EPOCH);
    seedActivePeer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A response body signed with `secret` over exactly the bytes we return. */
  function signedEpochResponse(instanceId: string, secret: string): Response {
    const responseBody = JSON.stringify({ instanceId });
    const sigHeaders = buildFederationHeaders(responseBody, secret, PEER_ORIGIN);
    return new Response(responseBody, { status: 200, headers: sigHeaders });
  }

  function readPeerInstanceId(): string | null {
    const row = testDb
      .select({ peerInstanceId: schema.federationPeers.peerInstanceId })
      .from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-remote'))
      .get();
    return row?.peerInstanceId ?? null;
  }

  it('populates peer_instance_id from a validly-signed response, then self-terminates', async () => {
    const fetchMock = vi.fn(async () => signedEpochResponse('E1', PEER_SECRET));
    vi.stubGlobal('fetch', fetchMock);

    const { refreshPeerEpochs } = await import('./federationEpoch.js');
    await refreshPeerEpochs();

    expect(readPeerInstanceId()).toBe('E1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second pass: the peer is now non-null, so the IS NULL filter excludes it —
    // no further fetch is issued. Self-termination is structural, not incidental.
    await refreshPeerEpochs();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readPeerInstanceId()).toBe('E1');
  });

  it('leaves the baseline NULL when the response signature is invalid (tampered)', async () => {
    // Signed with a different secret → verification fails → fetchPeerEpoch returns null.
    const fetchMock = vi.fn(async () => signedEpochResponse('E1', 'a-different-secret'));
    vi.stubGlobal('fetch', fetchMock);

    const { refreshPeerEpochs } = await import('./federationEpoch.js');
    await refreshPeerEpochs();

    expect(readPeerInstanceId()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the baseline NULL and does not throw on a 404 (peer not yet upgraded)', async () => {
    const fetchMock = vi.fn(async () => new Response('Not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const { refreshPeerEpochs } = await import('./federationEpoch.js');
    await expect(refreshPeerEpochs()).resolves.toBeUndefined();

    expect(readPeerInstanceId()).toBeNull();
  });

  it('never overwrites an already-populated baseline (populate-if-null only)', async () => {
    testDb.update(schema.federationPeers)
      .set({ peerInstanceId: 'pre-existing' })
      .where(eq(schema.federationPeers.id, 'peer-remote'))
      .run();

    const fetchMock = vi.fn(async () => signedEpochResponse('E1', PEER_SECRET));
    vi.stubGlobal('fetch', fetchMock);

    const { refreshPeerEpochs } = await import('./federationEpoch.js');
    await refreshPeerEpochs();

    // Already non-null → excluded by the IS NULL filter → no fetch, value untouched.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readPeerInstanceId()).toBe('pre-existing');
  });
});

describe('POST /api/federation/relay — fast-path epoch baseline (populate-if-null)', () => {
  // A verified inbound relay authentically carries the sender's current epoch in
  // `sourceInstanceId` (design §3.2). On the authenticated path only, the receiver
  // fills a NULL `peer_instance_id` — never overwrites a non-null baseline.
  let app: FastifyInstance;

  beforeEach(async () => {
    seedInstanceSettings(LOCAL_EPOCH);
    seedActivePeer();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  function readPeerInstanceId(): string | null {
    const row = testDb
      .select({ peerInstanceId: schema.federationPeers.peerInstanceId })
      .from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-remote'))
      .get();
    return row?.peerInstanceId ?? null;
  }

  /** Send a validly-signed relay (empty event batch) carrying `sourceInstanceId`. */
  async function injectSignedRelay(sourceInstanceId?: string): Promise<number> {
    const relay: Record<string, unknown> = {
      version: 1,
      sourceInstance: PEER_ORIGIN,
      events: [],
    };
    if (sourceInstanceId !== undefined) relay.sourceInstanceId = sourceInstanceId;
    const body = JSON.stringify(relay);
    const headers = buildFederationHeaders(body, PEER_SECRET, PEER_ORIGIN);
    const response = await app.inject({
      method: 'POST',
      url: '/api/federation/relay',
      headers,
      payload: body,
    });
    return response.statusCode;
  }

  it('populates a NULL baseline from the epoch a verified relay carries', async () => {
    expect(readPeerInstanceId()).toBeNull();
    const status = await injectSignedRelay('remote-epoch-A');
    expect(status).toBe(200);
    expect(readPeerInstanceId()).toBe('remote-epoch-A');
  });

  it('never overwrites a non-null baseline (a valid relay cannot carry a differing epoch)', async () => {
    const first = await injectSignedRelay('remote-epoch-A');
    expect(first).toBe(200);
    expect(readPeerInstanceId()).toBe('remote-epoch-A');

    // A subsequent relay claiming a different epoch must leave the baseline intact.
    const second = await injectSignedRelay('remote-epoch-B');
    expect(second).toBe(200);
    expect(readPeerInstanceId()).toBe('remote-epoch-A');
  });

  it('is a no-op when a pre-existing baseline is already set', async () => {
    testDb.update(schema.federationPeers)
      .set({ peerInstanceId: 'pre-existing' })
      .where(eq(schema.federationPeers.id, 'peer-remote'))
      .run();

    const status = await injectSignedRelay('remote-epoch-A');
    expect(status).toBe(200);
    expect(readPeerInstanceId()).toBe('pre-existing');
  });

  it('is a no-op for a backward-compatible relay that omits sourceInstanceId', async () => {
    const status = await injectSignedRelay(undefined);
    expect(status).toBe(200);
    expect(readPeerInstanceId()).toBeNull();
  });
});
