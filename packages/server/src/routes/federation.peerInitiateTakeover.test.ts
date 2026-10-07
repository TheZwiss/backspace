import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { buildFederationHeaders } from '../utils/federationAuth.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

// ensurePeered resolves an asserted origin before it sends anything to it.
// This suite is about who owns a pending row, not address policy.
vi.mock('dns', () => ({
  default: { promises: { lookup: async () => ({ address: '93.184.216.34', family: 4 }) } },
}));

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
    // The route's admin gate is not under test here.
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

const REMOTE = 'https://remote.example';
const AUTO_SECRET = 'auto-row-secret';

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
    instanceId: 'local-epoch-0000',
    autoAcceptPeering: 1,
    registrationOpen: 1,
    updatedAt: Date.now(),
  }).run();
}

function seedPendingRow(initiatedBy: 'admin' | 'auto' | 'remote'): void {
  testDb.insert(schema.federationPeers).values({
    id: 'peer-row',
    origin: REMOTE,
    hmacSecret: AUTO_SECRET,
    status: 'pending',
    initiatedBy,
    createdAt: Date.now(),
  }).run();
}

function seedQueuedDm(): void {
  const now = Date.now();
  testDb.insert(schema.federationOutbox).values({
    id: 'queued-dm',
    peerId: 'peer-row',
    contextId: 'dm-1',
    entityId: 'msg-1',
    contextType: 'dm',
    eventType: 'create',
    payload: '{}',
    encryptionVersion: 0,
    attempts: 0,
    nextRetryAt: now,
    expiresAt: now + 86_400_000,
    createdAt: now,
  }).run();
}

function peerRows(): Array<typeof schema.federationPeers.$inferSelect> {
  return testDb.select().from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, REMOTE)).all();
}

function outboxIds(): string[] {
  return testDb.select({ id: schema.federationOutbox.id }).from(schema.federationOutbox)
    .all().map(r => r.id);
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('./federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

/** A remote that adopts whatever secret it is sent and proves it on /epoch. */
function acceptingRemote(): ReturnType<typeof vi.fn> {
  let adopted = '';
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/federation/peer/accept')) {
      adopted = (JSON.parse(String(init?.body)) as { hmacSecret: string }).hmacSecret;
      return new Response(JSON.stringify({ accepted: true, instanceName: 'Remote', instanceId: 'remote-epoch' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.endsWith('/api/federation/epoch')) {
      const body = JSON.stringify({ instanceId: 'remote-epoch' });
      return new Response(body, { status: 200, headers: buildFederationHeaders(body, adopted, REMOTE) });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function initiate(app: FastifyInstance): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/federation/peer/initiate',
    payload: { remoteOrigin: REMOTE },
  });
}

describe('POST /api/federation/peer/initiate — an auto-created pending row', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    const { __resetInstanceIdCacheForTest } = await import('../utils/federationEpoch.js');
    __resetInstanceIdCacheForTest();
    const { _clearInFlightPeering } = await import('../utils/federationPeering.js');
    _clearInFlightPeering();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('is taken over and handshaked, keeping its row, secret and queued entries', async () => {
    seedPendingRow('auto');
    seedQueuedDm();
    const fetchMock = acceptingRemote();

    const response = await initiate(app);

    expect(response.statusCode).toBe(200);
    expect((response.json() as { verified?: boolean }).verified).toBe(true);
    const rows = peerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('peer-row');
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.initiatedBy).toBe('admin');
    expect(rows[0]!.hmacSecret).toBe(AUTO_SECRET);
    expect(outboxIds()).toEqual(['queued-dm']);
    const acceptCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/federation/peer/accept')) as unknown as [string, RequestInit];
    expect((JSON.parse(String(acceptCall[1].body)) as { hmacSecret: string }).hmacSecret).toBe(AUTO_SECRET);
  });

  it('when the remote queues it for approval, stays as the admin-initiated awaiting_approval row', async () => {
    seedPendingRow('auto');
    seedQueuedDm();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ approvalToken: 'a'.repeat(64) }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await initiate(app);

    expect(response.statusCode).toBe(202);
    const rows = peerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('peer-row');
    expect(rows[0]!.status).toBe('awaiting_approval');
    expect(rows[0]!.initiatedBy).toBe('admin');
    expect(outboxIds()).toEqual(['queued-dm']);
  });

  it('on a network failure, is handed back to local traffic with its entries and the attempt counted', async () => {
    seedPendingRow('auto');
    seedQueuedDm();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

    const response = await initiate(app);

    expect(response.statusCode).toBe(502);
    const rows = peerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('peer-row');
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.initiatedBy).toBe('auto');
    expect(rows[0]!.probeAttempts).toBe(1);
    expect(rows[0]!.lastProbeAt).not.toBeNull();
    expect(outboxIds()).toEqual(['queued-dm']);
  });

  it('on a 409 from the remote, is parked until the remote resets its older peering (#309)', async () => {
    seedPendingRow('auto');
    seedQueuedDm();
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/federation/epoch')) {
        return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
      }
      return new Response(JSON.stringify({ accepted: false, code: 'PEER_EXISTS_RESET_REQUIRED' }), {
        status: 409, headers: { 'content-type': 'application/json' },
      });
    }));

    const response = await initiate(app);

    expect(response.statusCode).toBe(409);
    expect((response.json() as { code?: string }).code).toBe('PEER_EXISTS_RESET_REQUIRED');
    const rows = peerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('rejected');
    expect(rows[0]!.statusReason).toBe('stale_peering_on_remote');
    // Parked rows are not retried; the conversation replays from the mutation
    // log once the peering is whole.
    expect(outboxIds()).toEqual([]);
  });

  it('answers 409 without a second exchange while ensurePeered is handshaking with the origin', async () => {
    seedPendingRow('auto');
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const { ensurePeered } = await import('../utils/federationPeering.js');
    const workerAttempt = ensurePeered(REMOTE, { kind: 'system' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const response = await initiate(app);
    expect(response.statusCode).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(new Response('', { status: 503 }));
    expect((await workerAttempt).status).toBe('failed');
  });

  it('keeps ensurePeered from starting a second exchange while the admin handshake runs', async () => {
    seedPendingRow('auto');
    seedQueuedDm();
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const adminRequest = initiate(app);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const { ensurePeered } = await import('../utils/federationPeering.js');
    expect((await ensurePeered(REMOTE, { kind: 'system' })).status).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(new Response(JSON.stringify({ approvalToken: 'b'.repeat(64) }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    expect((await adminRequest).statusCode).toBe(202);
  });
});

describe('POST /api/federation/peer/initiate — pending rows the admin or the remote created', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    const { __resetInstanceIdCacheForTest } = await import('../utils/federationEpoch.js');
    __resetInstanceIdCacheForTest();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('answers 409 for a remote-created pending row and leaves it alone', async () => {
    seedPendingRow('remote');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await initiate(app);

    expect(response.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = peerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.initiatedBy).toBe('remote');
    expect(rows[0]!.hmacSecret).toBe(AUTO_SECRET);
  });

  it("retries an admin's own pending row with its secret and keeps the row on a transient failure", async () => {
    seedPendingRow('admin');
    const sentSecrets: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/api/federation/peer/accept')) {
        sentSecrets.push((JSON.parse(String(init?.body)) as { hmacSecret: string }).hmacSecret);
      }
      throw new TypeError('fetch failed');
    }));

    const response = await initiate(app);

    expect(response.statusCode).toBe(502);
    expect(sentSecrets).toEqual([AUTO_SECRET]);
    const rows = peerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.initiatedBy).toBe('admin');
    expect(rows[0]!.hmacSecret).toBe(AUTO_SECRET);
    expect(rows[0]!.probeAttempts).toBe(1);
  });
});
