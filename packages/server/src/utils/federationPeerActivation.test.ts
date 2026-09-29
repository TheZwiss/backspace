import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

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
  processRelayEvents: vi.fn().mockResolvedValue({ accepted: [], rejected: [], undeliverable: [] }),
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
    evictFederatedCallsForHost: vi.fn().mockReturnValue(0),
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

describe('onPeerDeactivated', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.clearAllMocks();
  });

  it('evicts federated calls for the peer origin with peer_transient_failure on network_threshold', async () => {
    seedPeer('peer-net', 'unreachable');
    testDb.update(schema.federationPeers)
      .set({ instanceName: 'NetPeer' })
      .where(eq(schema.federationPeers.id, 'peer-net'))
      .run();

    const { onPeerDeactivated } = await import('./federationPeerActivation.js');
    await onPeerDeactivated('peer-net', 'network_threshold');

    const { connectionManager } = await import('../ws/handler.js');
    expect(connectionManager.evictFederatedCallsForHost).toHaveBeenCalledWith(
      'https://peer-net.example',
      { reason: 'peer_transient_failure', peerLabel: 'NetPeer' },
    );
  });

  it('maps rejected status to peer_rejected reason', async () => {
    seedPeer('peer-rej', 'rejected');
    const { onPeerDeactivated } = await import('./federationPeerActivation.js');
    await onPeerDeactivated('peer-rej', 'remote_refused');

    const { connectionManager } = await import('../ws/handler.js');
    expect(connectionManager.evictFederatedCallsForHost).toHaveBeenCalledWith(
      'https://peer-rej.example',
      { reason: 'peer_rejected', peerLabel: undefined },
    );
  });

  it('maps revoked status to peer_rejected reason', async () => {
    seedPeer('peer-rev', 'revoked');
    const { onPeerDeactivated } = await import('./federationPeerActivation.js');
    await onPeerDeactivated('peer-rev', 'admin_revoked');

    const { connectionManager } = await import('../ws/handler.js');
    expect(connectionManager.evictFederatedCallsForHost).toHaveBeenCalledWith(
      'https://peer-rev.example',
      { reason: 'peer_rejected', peerLabel: undefined },
    );
  });

  it('broadcasts federation_peers_changed to admins', async () => {
    seedPeer('peer-broad', 'unreachable');
    const { onPeerDeactivated } = await import('./federationPeerActivation.js');
    await onPeerDeactivated('peer-broad', 'network_threshold');

    const { connectionManager } = await import('../ws/handler.js');
    expect(connectionManager.sendToAdmins).toHaveBeenCalledWith({ type: 'federation_peers_changed' });
  });

  it('aborts silently when the peer row is missing', async () => {
    const { onPeerDeactivated } = await import('./federationPeerActivation.js');
    await expect(onPeerDeactivated('peer-missing', 'network_threshold')).resolves.toBeUndefined();

    const { connectionManager } = await import('../ws/handler.js');
    expect(connectionManager.evictFederatedCallsForHost).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent calls for the same peerId', async () => {
    seedPeer('peer-x', 'unreachable');
    const { onPeerDeactivated } = await import('./federationPeerActivation.js');
    const { connectionManager } = await import('../ws/handler.js');

    const p1 = onPeerDeactivated('peer-x', 'network_threshold');
    const p2 = onPeerDeactivated('peer-x', 'network_threshold');
    await Promise.all([p1, p2]);

    // Exactly one eviction call, not two
    expect(connectionManager.evictFederatedCallsForHost).toHaveBeenCalledTimes(1);
  });

  it('uses a dedup map SEPARATE from onPeerActivated', async () => {
    seedPeer('peer-flap', 'active');
    const { onPeerActivated, onPeerDeactivated } = await import('./federationPeerActivation.js');

    // Simulate an activation already in flight — spawn onPeerActivated then
    // immediately kick off a deactivation for the same peer id. The latter
    // must NOT be swallowed as a dedup hit against the activation.
    const actPromise = onPeerActivated('peer-flap', 'ensure_peered');

    // Mark peer non-active now — otherwise the deactivation utility's
    // own status guard would skip it.
    testDb.update(schema.federationPeers)
      .set({ status: 'unreachable' })
      .where(eq(schema.federationPeers.id, 'peer-flap'))
      .run();

    const deactPromise = onPeerDeactivated('peer-flap', 'network_threshold');
    await Promise.all([actPromise, deactPromise]);

    const { connectionManager } = await import('../ws/handler.js');
    expect(connectionManager.evictFederatedCallsForHost).toHaveBeenCalled();
  });
});
