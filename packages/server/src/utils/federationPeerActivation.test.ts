import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import * as federationRouteMock from '../routes/federation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('../utils/federationOutbox.js', () => ({
  isFederationRelayEnabled: () => true,
}));

vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://local.example',
  buildFederationHeaders: (_body: string, _secret: string, _origin: string) => ({
    'Content-Type': 'application/json',
    'X-Federation-Origin': _origin,
  }),
}));

vi.mock('../routes/federation.js', () => ({
  processRelayEvents: vi.fn().mockResolvedValue({ accepted: [], rejected: [] }),
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
  },
}));

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

function seedPeer(id: string, status: string, lastSyncedAt = 0): void {
  testDb.insert(schema.federationPeers).values({
    id, origin: `https://${id}.example`, hmacSecret: 'secret',
    status, lastSyncedAt, createdAt: Date.now(),
  }).run();
}

function seedOutboxEntry(id: string, peerId: string, nextRetryAt: number, attempts: number): void {
  testDb.insert(schema.federationOutbox).values({
    id, peerId, contextId: 'ch-1', entityId: `msg-${id}`,
    contextType: 'dm', eventType: 'create', payload: '{}',
    encryptionVersion: 0, attempts, nextRetryAt,
    expiresAt: Date.now() + 30 * 86_400_000,
    createdAt: Date.now(),
  }).run();
}

describe('resetOutboxBackoff', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
  });

  it('resets nextRetryAt=now and attempts=0 for all peer entries — including past-due ones', async () => {
    const { resetOutboxBackoff } = await import('./federationPeerActivation.js');
    seedPeer('peer-a', 'active');
    seedPeer('peer-b', 'active');
    const now = Date.now();

    // Three entries for peer-a: past-due (already eligible), near-future, far-future
    seedOutboxEntry('entry-1', 'peer-a', now - 1000, 5);
    seedOutboxEntry('entry-2', 'peer-a', now + 60_000, 3);
    seedOutboxEntry('entry-3', 'peer-a', now + 86_400_000, 7);
    // Entry for unrelated peer-b (must NOT be touched)
    seedOutboxEntry('entry-4', 'peer-b', now + 86_400_000, 9);

    resetOutboxBackoff('peer-a');

    const a1 = testDb.select().from(schema.federationOutbox).where(eq(schema.federationOutbox.id, 'entry-1')).get();
    const a2 = testDb.select().from(schema.federationOutbox).where(eq(schema.federationOutbox.id, 'entry-2')).get();
    const a3 = testDb.select().from(schema.federationOutbox).where(eq(schema.federationOutbox.id, 'entry-3')).get();
    const b4 = testDb.select().from(schema.federationOutbox).where(eq(schema.federationOutbox.id, 'entry-4')).get();

    // All peer-a entries reset — including the past-due one (correctness: attempts=0 on those too)
    expect(a1?.attempts).toBe(0);
    expect(a2?.attempts).toBe(0);
    expect(a3?.attempts).toBe(0);
    expect(a1?.nextRetryAt).toBeGreaterThanOrEqual(now);
    expect(a2?.nextRetryAt).toBeLessThanOrEqual(Date.now());
    expect(a3?.nextRetryAt).toBeLessThanOrEqual(Date.now());
    // peer-b untouched
    expect(b4?.attempts).toBe(9);
    expect(b4?.nextRetryAt).toBe(now + 86_400_000);
  });

  it('is a no-op when the peer has no outbox entries', async () => {
    const { resetOutboxBackoff } = await import('./federationPeerActivation.js');
    seedPeer('peer-empty', 'active');
    expect(() => resetOutboxBackoff('peer-empty')).not.toThrow();
  });
});

describe('syncPeerMutationLog', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.restoreAllMocks();
  });

  it('seeds sinceTimestamp from peer.lastSyncedAt for each pass', async () => {
    const { syncPeerMutationLog } = await import('./federationPeerActivation.js');
    testDb.insert(schema.federationPeers).values({
      id: 'peer-1', origin: 'https://peer-1.example', hmacSecret: 'secret',
      status: 'active', lastSyncedAt: 5000, createdAt: Date.now(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ events: [], hasMore: false, checkpoint: 5000 }), { status: 200 })
    );

    await syncPeerMutationLog('peer-1', 'health_check_recovery');

    // Three passes: dm (no contextType), friend, profile
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const call of fetchSpy.mock.calls) {
      const body = JSON.parse(call[1]?.body as string) as { sinceTimestamp: number };
      expect(body.sinceTimestamp).toBe(5000);
    }
    const calls = fetchSpy.mock.calls.map(c => JSON.parse(c[1]?.body as string) as { contextType?: string });
    expect(calls[0]!.contextType).toBeUndefined();       // DM pass (no contextType filter)
    expect(calls[1]!.contextType).toBe('friend');
    expect(calls[2]!.contextType).toBe('profile');
  });

  it('advances lastSyncedAt on success', async () => {
    const { syncPeerMutationLog } = await import('./federationPeerActivation.js');
    testDb.insert(schema.federationPeers).values({
      id: 'peer-2', origin: 'https://peer-2.example', hmacSecret: 'secret',
      status: 'active', lastSyncedAt: 0, createdAt: Date.now(),
    }).run();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ events: [], hasMore: false, checkpoint: 1000 }), { status: 200 })
    );

    const before = Date.now();
    await syncPeerMutationLog('peer-2', 'startup_bootstrap');
    const after = Date.now();

    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-2')).get();
    expect(row?.lastSyncedAt).toBeGreaterThanOrEqual(before);
    expect(row?.lastSyncedAt).toBeLessThanOrEqual(after);
  });

  it('does NOT update lastSyncedAt on transient failure', async () => {
    const { syncPeerMutationLog } = await import('./federationPeerActivation.js');
    testDb.insert(schema.federationPeers).values({
      id: 'peer-3', origin: 'https://peer-3.example', hmacSecret: 'secret',
      status: 'active', lastSyncedAt: 42_000, createdAt: Date.now(),
    }).run();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('internal error', { status: 500 })
    );

    await syncPeerMutationLog('peer-3', 'ensure_peered');
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-3')).get();
    expect(row?.lastSyncedAt).toBe(42_000);
  });

  it('does nothing when peer is not active', async () => {
    const { syncPeerMutationLog } = await import('./federationPeerActivation.js');
    testDb.insert(schema.federationPeers).values({
      id: 'peer-4', origin: 'https://peer-4.example', hmacSecret: 'secret',
      status: 'pending', lastSyncedAt: 0, createdAt: Date.now(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await syncPeerMutationLog('peer-4', 'health_check_recovery');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('advances sinceTimestamp within a pass using data.checkpoint when hasMore is true', async () => {
    const { syncPeerMutationLog } = await import('./federationPeerActivation.js');
    testDb.insert(schema.federationPeers).values({
      id: 'peer-5', origin: 'https://peer-5.example', hmacSecret: 'secret',
      status: 'active', lastSyncedAt: 100, createdAt: Date.now(),
    }).run();

    let call = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      // First DM call: one event, hasMore=true, checkpoint advances to 2500
      // Second DM call: empty, hasMore=false, ends the DM pass
      // Remaining calls (friend, profile): empty/done immediately
      if (call === 1) {
        return new Response(
          JSON.stringify({
            events: [{ eventType: 'create', messageId: 'm1', timestamp: 200, encryptionVersion: 0 }],
            hasMore: true,
            checkpoint: 2500,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ events: [], hasMore: false, checkpoint: call === 2 ? 2500 : 100 }), { status: 200 });
    });

    await syncPeerMutationLog('peer-5', 'health_check_recovery');

    // Call 1: DM pass, since=100 (peer.lastSyncedAt)
    // Call 2: DM pass continuation, since=2500 (advanced by previous checkpoint)
    // Call 3: friend pass, since=100 (re-seeded from peer.lastSyncedAt)
    // Call 4: profile pass, since=100 (re-seeded from peer.lastSyncedAt)
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const bodies = fetchSpy.mock.calls.map(c => JSON.parse(c[1]?.body as string) as { sinceTimestamp: number; contextType?: string });
    expect(bodies[0]?.sinceTimestamp).toBe(100);
    expect(bodies[0]?.contextType).toBeUndefined();
    expect(bodies[1]?.sinceTimestamp).toBe(2500);  // advanced by checkpoint from call 1
    expect(bodies[1]?.contextType).toBeUndefined();
    expect(bodies[2]?.sinceTimestamp).toBe(100);   // friend pass re-seeds from peer.lastSyncedAt
    expect(bodies[2]?.contextType).toBe('friend');
    expect(bodies[3]?.sinceTimestamp).toBe(100);   // profile pass re-seeds from peer.lastSyncedAt
    expect(bodies[3]?.contextType).toBe('profile');
  });

  it('skips a poison-pill event, logs it, and advances past it to process subsequent events', async () => {
    const { syncPeerMutationLog } = await import('./federationPeerActivation.js');
    testDb.insert(schema.federationPeers).values({
      id: 'peer-poison', origin: 'https://peer-poison.example', hmacSecret: 'secret',
      status: 'active', lastSyncedAt: 100, createdAt: Date.now(),
    }).run();

    // Return a single batch of 3 events on the DM pass, then empty on friend + profile passes.
    let fetchCall = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCall++;
      if (fetchCall === 1) {
        return new Response(JSON.stringify({
          events: [
            { eventType: 'create', messageId: 'good-1', timestamp: 200, encryptionVersion: 0 },
            { eventType: 'create', messageId: 'poison', timestamp: 300, encryptionVersion: 0 },
            { eventType: 'create', messageId: 'good-2', timestamp: 400, encryptionVersion: 0 },
          ],
          hasMore: false,
          checkpoint: 400,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ events: [], hasMore: false, checkpoint: 100 }), { status: 200 });
    });

    // Grab the top-level mock and override implementation per-call:
    // good-1: resolves, poison: throws, good-2: resolves.
    const processMock = vi.mocked(federationRouteMock.processRelayEvents);
    processMock.mockClear();
    processMock.mockResolvedValueOnce(undefined as never);  // good-1
    processMock.mockRejectedValueOnce(new Error('simulated processor failure'));  // poison
    processMock.mockResolvedValueOnce(undefined as never);  // good-2

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const before = Date.now();
    await syncPeerMutationLog('peer-poison', 'health_check_recovery');

    // Verify processRelayEvents was called per-event: 3 calls for the 3 DM events.
    expect(processMock).toHaveBeenCalledTimes(3);

    // Verify error logged for the poison event.
    expect(errorSpy).toHaveBeenCalled();
    const errorMessages = errorSpy.mock.calls.map(c => String(c[0] ?? ''));
    expect(errorMessages.some(m => m.includes('poison'))).toBe(true);
    expect(errorMessages.some(m => m.includes('simulated processor failure'))).toBe(true);

    // Verify lastSyncedAt advanced despite the poison event (the critical property).
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-poison')).get();
    expect(row?.lastSyncedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('onPeerActivated', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.restoreAllMocks();
  });

  it('runs resetOutboxBackoff and syncPeerMutationLog once, even under concurrent calls', async () => {
    const { onPeerActivated } = await import('./federationPeerActivation.js');

    testDb.insert(schema.federationPeers).values({
      id: 'peer-x', origin: 'https://peer-x.example', hmacSecret: 'secret',
      status: 'active', lastSyncedAt: 0, createdAt: Date.now(),
    }).run();

    let fetchCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCount++;
      // Deliberately slow to let the second concurrent call share the in-flight promise.
      await new Promise(r => setTimeout(r, 20));
      return new Response(JSON.stringify({ events: [], hasMore: false, checkpoint: 0 }), { status: 200 });
    });

    const p1 = onPeerActivated('peer-x', 'health_check_recovery');
    const p2 = onPeerActivated('peer-x', 'accept_new');
    await Promise.all([p1, p2]);

    // Three fetch calls for the three sync passes (dm, friend, profile) — not six.
    expect(fetchCount).toBe(3);
  });

  it('swallows errors from syncPeerMutationLog so the handler does not throw', async () => {
    const { onPeerActivated } = await import('./federationPeerActivation.js');

    testDb.insert(schema.federationPeers).values({
      id: 'peer-err', origin: 'https://peer-err.example', hmacSecret: 'secret',
      status: 'active', lastSyncedAt: 0, createdAt: Date.now(),
    }).run();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network down');
    });

    await expect(onPeerActivated('peer-err', 'ensure_peered')).resolves.toBeUndefined();
  });
});
