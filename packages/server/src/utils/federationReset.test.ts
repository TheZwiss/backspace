import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));

const sendToAdmins = vi.fn();
vi.mock('../ws/handler.js', () => ({
  connectionManager: { sendToAdmins, getAllOnlineUserIds: () => [], sendToUser: vi.fn() },
}));

const STUB = '!federation-replicated';
const ORIGIN = 'https://peer.example';
const DOMAIN = 'peer.example';

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedPeer(): void {
  testDb.insert(schema.federationPeers).values({
    id: 'peer-1', origin: ORIGIN, hmacSecret: 'trusted-secret',
    status: 'active', peerInstanceId: 'E0', lastSeenAt: Date.now(),
    lastSyncedAt: Date.now(), createdAt: Date.now(),
  }).run();
}

function seedUser(id: string, opts: { passwordHash: string; isDeleted?: number; homeInstance?: string }): void {
  testDb.insert(schema.users).values({
    id, username: `${id}@${DOMAIN}`, passwordHash: opts.passwordHash,
    homeInstance: opts.homeInstance ?? DOMAIN, homeUserId: id,
    isDeleted: opts.isDeleted ?? 0, createdAt: Date.now(),
  }).run();
}

describe('markPeerReset — detection-only reset routing', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.clearAllMocks();
  });

  afterEach(() => {
    sqlite.close();
  });

  it('routes peer to needs_attention, snapshots the dead incarnation, and journals the dead epoch', async () => {
    seedPeer();
    // Two non-deleted users for the reset origin: one pure S2S stub, one real account.
    seedUser('stub-1', { passwordHash: STUB });
    seedUser('real-1', { passwordHash: '$2b$10$realbcrypthash' });
    // A deleted stub for the same origin — must NOT be flagged.
    seedUser('stub-deleted', { passwordHash: STUB, isDeleted: 1 });
    // An unrelated user on a different origin — must NOT be flagged.
    seedUser('other-1', { passwordHash: STUB, homeInstance: 'elsewhere.example' });

    const { markPeerReset } = await import('./federationReset.js');
    markPeerReset('peer-1', ORIGIN, 'E0', 'E1');

    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-1')).get()!;
    expect(peer.status).toBe('needs_attention');
    expect(peer.needsAttentionReason).toBe('peer_reset_detected');
    expect(peer.observedPeerInstanceId).toBe('E1');
    // Trusted baseline + secret are NEVER touched by detection.
    expect(peer.peerInstanceId).toBe('E0');
    expect(peer.hmacSecret).toBe('trusted-secret');

    const flag = (id: string) => testDb.select().from(schema.users)
      .where(eq(schema.users.id, id)).get()!.federationHealPending;
    expect(flag('stub-1')).toBe(1);
    expect(flag('real-1')).toBe(1);
    expect(flag('stub-deleted')).toBe(0); // deleted → excluded from snapshot
    expect(flag('other-1')).toBe(0);      // different origin → excluded

    const journal = testDb.select().from(schema.federationResetEvents)
      .where(eq(schema.federationResetEvents.origin, ORIGIN)).get()!;
    expect(journal.deadEpoch).toBe('E0');
    expect(journal.newEpoch).toBeNull();
    expect(journal.resolvedAt).toBeNull();
    expect(journal.stubCount).toBe(1);            // stub-1 only (deleted stub excluded)
    expect(journal.orphanedAccountCount).toBe(1); // real-1

    // Admin broadcast fired.
    expect(sendToAdmins).toHaveBeenCalledWith({ type: 'federation_peers_changed' });
    expect(sendToAdmins).toHaveBeenCalledWith({ type: 'federation_peer_reset_detected', origin: ORIGIN });
  });

  it('double-reset keeps the original dead_epoch and detected_at (only counts refresh)', async () => {
    seedPeer();
    seedUser('stub-1', { passwordHash: STUB });
    seedUser('real-1', { passwordHash: '$2b$10$realbcrypthash' });

    const { markPeerReset } = await import('./federationReset.js');
    markPeerReset('peer-1', ORIGIN, 'E0', 'E1');
    const first = testDb.select().from(schema.federationResetEvents)
      .where(eq(schema.federationResetEvents.origin, ORIGIN)).get()!;
    const originalDetectedAt = first.detectedAt;

    // Peer resets AGAIN before an admin resolved the first reset.
    markPeerReset('peer-1', ORIGIN, 'E0', 'E2');
    const second = testDb.select().from(schema.federationResetEvents)
      .where(eq(schema.federationResetEvents.origin, ORIGIN)).get()!;

    // The dead epoch is the ALREADY-snapshotted incarnation — never overwritten.
    expect(second.deadEpoch).toBe('E0');
    expect(second.detectedAt).toBe(originalDetectedAt);
    expect(second.resolvedAt).toBeNull();
    // The observed epoch on the peer row does advance to the newest observation.
    expect(testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-1')).get()!.observedPeerInstanceId).toBe('E2');
  });

  it('a resolved prior reset starts a fresh journal entry on a new reset', async () => {
    seedPeer();
    seedUser('stub-1', { passwordHash: STUB });

    const { markPeerReset } = await import('./federationReset.js');
    markPeerReset('peer-1', ORIGIN, 'E0', 'E1');
    // Simulate the heal having resolved the first reset.
    testDb.update(schema.federationResetEvents)
      .set({ resolvedAt: Date.now(), newEpoch: 'E1' })
      .where(eq(schema.federationResetEvents.origin, ORIGIN)).run();

    // A brand-new reset lands: dead_epoch should update to the new baseline.
    markPeerReset('peer-1', ORIGIN, 'E1', 'E2');
    const row = testDb.select().from(schema.federationResetEvents)
      .where(eq(schema.federationResetEvents.origin, ORIGIN)).get()!;
    expect(row.deadEpoch).toBe('E1');
    expect(row.newEpoch).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });

  it('matches home_instance stored as a full URL (defensive format match)', async () => {
    seedPeer();
    // Legacy straggler stored with the https:// prefix rather than bare domain.
    seedUser('stub-url', { passwordHash: STUB, homeInstance: ORIGIN });

    const { markPeerReset } = await import('./federationReset.js');
    markPeerReset('peer-1', ORIGIN, 'E0', 'E1');

    expect(testDb.select().from(schema.users)
      .where(eq(schema.users.id, 'stub-url')).get()!.federationHealPending).toBe(1);
  });
});
