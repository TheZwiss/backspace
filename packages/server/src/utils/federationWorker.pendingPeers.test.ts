import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { __resetInstanceIdCacheForTest } from './federationEpoch.js';
import type { EnsurePeeredResult } from './federationPeering.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
    evictFederatedCallsForHost: vi.fn().mockReturnValue(0),
    dropRemoteCallParticipants: vi.fn().mockReturnValue(0),
    getAllFederatedCalls: vi.fn(() => new Map()),
  },
}));

vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://test.example',
  buildFederationHeaders: () => ({ 'Content-Type': 'application/json' }),
  generateHmacSecret: () => 'secret',
  ROTATION_GRACE_PERIOD_MS: 15 * 60 * 1000,
}));

vi.mock('../utils/federationOutbox.js', () => ({
  isFederationRelayEnabled: () => true,
  queueOutboxEvent: vi.fn(),
  appendMutationLog: vi.fn(),
}));

vi.mock('../utils/federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(),
  onPeerDeactivated: vi.fn().mockResolvedValue(undefined),
  startupBootstrapSync: vi.fn(),
}));

vi.mock('../utils/storageJanitor.js', () => ({
  runFederationJanitor: vi.fn(),
}));

vi.mock('../utils/thumbnail.js', () => ({
  generateThumbnail: vi.fn(),
}));

vi.mock('../routes/dm.js', () => ({
  getDmMessageWithUser: vi.fn(),
}));

// The handshake itself is not under test here: the worker's scheduling of it
// is. Each test decides what the handshake does (never answer, fail).
const ensurePeeredMock = vi.fn<(origin: string, intent: { kind: 'system' }) => Promise<EnsurePeeredResult>>();
const handshakeInFlightMock = vi.fn<(origin: string) => boolean>(() => false);
vi.mock('./federationPeering.js', () => ({
  ensurePeered: (origin: string, intent: { kind: 'system' }) => ensurePeeredMock(origin, intent),
  isHandshakeInFlight: (origin: string) => handshakeInFlightMock(origin),
}));

const ACTIVE_ORIGIN = 'https://active.example';
const SILENT_ORIGIN = 'https://silent.example';
const OTHER_PENDING_ORIGIN = 'https://other-pending.example';

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedInstanceEpoch(): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceId: 'worker-test-epoch',
    updatedAt: Date.now(),
  } as typeof schema.instanceSettings.$inferInsert).run();
  __resetInstanceIdCacheForTest();
}

function seedPeer(id: string, origin: string, status: 'active' | 'pending'): void {
  testDb.insert(schema.federationPeers).values({
    id, origin, hmacSecret: 'secret', status, initiatedBy: 'auto',
    lastSyncedAt: Date.now(), createdAt: Date.now(),
  }).run();
}

function seedOutboxEntry(id: string, peerId: string, entityId: string): void {
  testDb.insert(schema.federationOutbox).values({
    id, peerId, contextId: 'ch-1', entityId,
    contextType: 'dm', eventType: 'create', payload: JSON.stringify({
      message: { userId: 'u', homeUserId: 'u', homeInstance: 'test.example', content: 'hi', replyToId: null, editedAt: null, createdAt: Date.now() },
    }),
    encryptionVersion: 0, attempts: 0, nextRetryAt: Date.now() - 1000,
    expiresAt: Date.now() + 30 * 86_400_000,
    createdAt: Date.now(),
  }).run();
}

function outboxIds(): string[] {
  return testDb.select({ id: schema.federationOutbox.id }).from(schema.federationOutbox)
    .all().map(r => r.id).sort();
}

/** A relay endpoint that accepts every event it is sent. */
function acceptEverything(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { events: Array<{ messageId: string }> };
    return new Response(JSON.stringify({
      accepted: body.events.map(e => e.messageId),
      rejected: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Resolves once every already-settled promise continuation has run. */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/** The tick's own outcome, or 'hung' if it has not finished by the deadline. */
async function tickWithin(ms: number): Promise<'done' | 'hung'> {
  const { processOutboxTick } = await import('./federationWorker.js');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'hung'>(resolve => { timer = setTimeout(() => resolve('hung'), ms); });
  try {
    return await Promise.race([processOutboxTick().then(() => 'done' as const), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('outbox worker — pending peer handshakes do not hold up delivery', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceEpoch();
    // Fresh worker module per test: a handshake a test leaves unanswered must
    // not stay registered as in flight for the next one.
    vi.resetModules();
    ensurePeeredMock.mockReset();
    handshakeInFlightMock.mockReset();
    handshakeInFlightMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    sqlite.close();
  });

  it('a pending origin that never answers does not stall the tick or delivery to an active peer', async () => {
    seedPeer('peer-active', ACTIVE_ORIGIN, 'active');
    seedPeer('peer-silent', SILENT_ORIGIN, 'pending');
    seedOutboxEntry('e-active-1', 'peer-active', 'm-active-1');
    seedOutboxEntry('e-silent', 'peer-silent', 'm-silent');
    ensurePeeredMock.mockImplementation(() => new Promise<EnsurePeeredResult>(() => { /* never answers */ }));
    const fetchMock = acceptEverything();

    expect(await tickWithin(1_000)).toBe('done');
    expect(ensurePeeredMock).toHaveBeenCalledWith(SILENT_ORIGIN, { kind: 'system' });
    expect(fetchMock).toHaveBeenCalledWith(`${ACTIVE_ORIGIN}/api/federation/relay`, expect.anything());
    expect(outboxIds()).toEqual(['e-silent']);

    // The next tick still delivers new mail to the active peer while the
    // silent origin's handshake is outstanding.
    seedOutboxEntry('e-active-2', 'peer-active', 'm-active-2');
    expect(await tickWithin(1_000)).toBe('done');
    expect(outboxIds()).toEqual(['e-silent']);
  });

  it('a pending origin that never answers does not delay the handshake of another pending origin', async () => {
    seedPeer('peer-silent', SILENT_ORIGIN, 'pending');
    seedPeer('peer-other', OTHER_PENDING_ORIGIN, 'pending');
    seedOutboxEntry('e-silent', 'peer-silent', 'm-silent');
    seedOutboxEntry('e-other', 'peer-other', 'm-other');
    ensurePeeredMock.mockImplementation(() => new Promise<EnsurePeeredResult>(() => { /* never answers */ }));
    acceptEverything();

    expect(await tickWithin(1_000)).toBe('done');
    const origins = ensurePeeredMock.mock.calls.map(([origin]) => origin).sort();
    expect(origins).toEqual([OTHER_PENDING_ORIGIN, SILENT_ORIGIN]);
  });

  it('keeps at most one handshake in flight per origin', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    seedPeer('peer-silent', SILENT_ORIGIN, 'pending');
    seedOutboxEntry('e-silent', 'peer-silent', 'm-silent');
    ensurePeeredMock.mockImplementation(() => new Promise<EnsurePeeredResult>(() => { /* never answers */ }));
    acceptEverything();

    expect(await tickWithin(1_000)).toBe('done');
    // Long past every step of the schedule: the only thing holding the next
    // attempt back is the one still outstanding.
    vi.setSystemTime(t0 + 60 * 60 * 1000);
    expect(await tickWithin(1_000)).toBe('done');
    expect(ensurePeeredMock).toHaveBeenCalledTimes(1);
  });

  it('does not start a handshake for an origin that already has one in flight elsewhere', async () => {
    seedPeer('peer-silent', SILENT_ORIGIN, 'pending');
    seedOutboxEntry('e-silent', 'peer-silent', 'm-silent');
    handshakeInFlightMock.mockReturnValue(true);
    ensurePeeredMock.mockResolvedValue({ status: 'failed', error: 'should not be called' });
    acceptEverything();

    expect(await tickWithin(1_000)).toBe('done');
    await flushMicrotasks();
    expect(ensurePeeredMock).not.toHaveBeenCalled();
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-silent')).get()!;
    expect(row.probeAttempts).toBe(0);
    expect(row.lastProbeAt).toBeNull();
  });
});

describe('outbox worker — pending peer retries follow the recovery schedule', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceEpoch();
    // Fresh worker module per test: a handshake a test leaves unanswered must
    // not stay registered as in flight for the next one.
    vi.resetModules();
    ensurePeeredMock.mockReset();
    handshakeInFlightMock.mockReset();
    handshakeInFlightMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    sqlite.close();
  });

  it('retries a failing pending origin on RECOVERY_BACKOFF_MS, not on every tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    seedPeer('peer-silent', SILENT_ORIGIN, 'pending');
    seedOutboxEntry('e-silent', 'peer-silent', 'm-silent');
    // The handshake counts its own failed attempt on the row (whoever started
    // it), as performHandshake does through recordPeerAttempt.
    const { recordPeerAttempt } = await import('./federationPeerState.js');
    ensurePeeredMock.mockImplementation(async () => {
      recordPeerAttempt('peer-silent', { from: ['pending'], startedAt: Date.now() });
      return { status: 'failed', error: 'Remote instance did not respond within 10 seconds' };
    });
    acceptEverything();

    const { processOutboxTick } = await import('./federationWorker.js');
    const tickAt = async (at: number): Promise<number> => {
      vi.setSystemTime(at);
      await processOutboxTick();
      await flushMicrotasks();
      return ensurePeeredMock.mock.calls.length;
    };

    // First attempt is immediate (no attempt recorded yet).
    expect(await tickAt(t0)).toBe(1);
    const afterFirst = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-silent')).get()!;
    expect(afterFirst.probeAttempts).toBe(1);
    expect(afterFirst.lastProbeAt).toBe(t0);

    // One failed attempt → RECOVERY_BACKOFF_MS[0] = 30 seconds (#322).
    expect(await tickAt(t0 + 1_000)).toBe(1);
    expect(await tickAt(t0 + 29_999)).toBe(1);
    const t1 = t0 + 30_000;
    expect(await tickAt(t1)).toBe(2);

    // Two failed attempts → 1 minute.
    expect(await tickAt(t1 + 59_999)).toBe(2);
    const t2 = t1 + 60_000;
    expect(await tickAt(t2)).toBe(3);

    // Three failed attempts → 5 minutes.
    expect(await tickAt(t2 + 299_999)).toBe(3);
    const t3 = t2 + 300_000;
    expect(await tickAt(t3)).toBe(4);

    // Four failed attempts → 15 minutes, and the schedule stays clamped there.
    expect(await tickAt(t3 + 899_999)).toBe(4);
    const t4 = t3 + 900_000;
    expect(await tickAt(t4)).toBe(5);
    expect(await tickAt(t4 + 899_999)).toBe(5);
    expect(await tickAt(t4 + 900_000)).toBe(6);
  });
});
