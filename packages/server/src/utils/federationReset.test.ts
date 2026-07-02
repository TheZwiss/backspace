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

describe('healResetIncarnation — heal after authenticated re-peer', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.clearAllMocks();
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedJournal(deadEpoch: string): void {
    testDb.insert(schema.federationResetEvents).values({
      origin: ORIGIN, deadEpoch, newEpoch: null,
      detectedAt: Date.now(), resolvedAt: null,
      stubCount: 1, orphanedAccountCount: 1,
    }).run();
  }

  function flag(id: string): void {
    testDb.update(schema.users).set({ federationHealPending: 1 })
      .where(eq(schema.users.id, id)).run();
  }

  it('genuine reset: soft-tombstones flagged stubs, detaches real accounts (flag only, name kept), resolves journal', async () => {
    seedPeer();
    seedJournal('E0');
    // A local native user to be the friendship counterpart.
    testDb.insert(schema.users).values({
      id: 'local-1', username: 'alice', passwordHash: '$2b$10$localhash',
      homeInstance: null, homeUserId: null, isDeleted: 0, createdAt: Date.now(),
    }).run();
    // Flagged pure S2S stub with a friendship to the local user.
    seedUser('stub-1', { passwordHash: STUB });
    flag('stub-1');
    testDb.insert(schema.friends).values({
      userId: 'stub-1', friendId: 'local-1', createdAt: Date.now(),
    }).run();
    // Flagged REAL federated account (real bcrypt), no owned space — must survive
    // (never deleted) and be DETACHED: flagged orphaned, username preserved.
    seedUser('real-1', { passwordHash: '$2b$10$realbcrypthash' });
    flag('real-1');

    const { healResetIncarnation } = await import('./federationReset.js');
    healResetIncarnation(ORIGIN, 'E1', 'initiate_accepted');

    // Stub soft-tombstoned.
    const stub = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-1')).get()!;
    expect(stub.isDeleted).toBe(1);
    expect(stub.username).toBe('!deleted:stub-1');
    // Its friendship row is gone → re-adds work again.
    expect(testDb.select().from(schema.friends)
      .where(eq(schema.friends.userId, 'stub-1')).all()).toHaveLength(0);
    // Heal flag cleared on the healed stub.
    expect(stub.federationHealPending).toBe(0);

    // Real account NEVER deleted (content preserved) and DETACHED: orphaned flag
    // set, username PRESERVED, heal flag cleared (detach spec §4.2).
    const real = testDb.select().from(schema.users).where(eq(schema.users.id, 'real-1')).get()!;
    expect(real.isDeleted).toBe(0);
    expect(real.username).toBe('real-1@peer.example'); // unchanged — no rename
    expect(real.federationHomeOrphaned).toBe(1);
    expect(real.federationHealPending).toBe(0);

    // Journal resolved with the freshly-handshaked epoch.
    const journal = testDb.select().from(schema.federationResetEvents)
      .where(eq(schema.federationResetEvents.origin, ORIGIN)).get()!;
    expect(journal.resolvedAt).not.toBeNull();
    expect(journal.newEpoch).toBe('E1');
  });

  it('false positive (re-peer confirmed same incarnation): NO tombstone, flags cleared, journal resolved', async () => {
    seedPeer();
    seedJournal('E0');
    seedUser('stub-1', { passwordHash: STUB });
    flag('stub-1');

    const { healResetIncarnation } = await import('./federationReset.js');
    healResetIncarnation(ORIGIN, 'E0', 'accept_new'); // dead_epoch === newEpoch → false alarm

    const stub = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-1')).get()!;
    expect(stub.isDeleted).toBe(0);                        // NOT tombstoned
    expect(stub.username).toBe('stub-1@peer.example');
    expect(stub.federationHealPending).toBe(0);            // flag cleared

    const journal = testDb.select().from(schema.federationResetEvents)
      .where(eq(schema.federationResetEvents.origin, ORIGIN)).get()!;
    expect(journal.resolvedAt).not.toBeNull();
    expect(journal.newEpoch).toBe('E0');
  });

  it('recovery/startup flip must NOT resolve the journal or clear flags (the critical guard)', async () => {
    seedPeer();
    seedJournal('E0');
    seedUser('stub-1', { passwordHash: STUB });
    flag('stub-1');

    const { healResetIncarnation } = await import('./federationReset.js');

    // Both non-handshake reasons flip a peer to active with a STALE baseline
    // (still E0). Without the reason gate they'd hit dead_epoch === newEpoch and
    // silently resolve the journal WITHOUT healing → the bug permanently buried.
    for (const reason of ['health_check_recovery', 'startup_bootstrap'] as const) {
      healResetIncarnation(ORIGIN, 'E0', reason);

      const journal = testDb.select().from(schema.federationResetEvents)
        .where(eq(schema.federationResetEvents.origin, ORIGIN)).get()!;
      expect(journal.resolvedAt, `reason=${reason}`).toBeNull();
      expect(journal.newEpoch, `reason=${reason}`).toBeNull();

      const stub = testDb.select().from(schema.users)
        .where(eq(schema.users.id, 'stub-1')).get()!;
      expect(stub.federationHealPending, `reason=${reason}`).toBe(1);
      expect(stub.isDeleted, `reason=${reason}`).toBe(0);
    }
  });

  it('broadcasts user_updated to the survivor of a tombstoned stub 1-on-1 DM', async () => {
    seedPeer();
    seedJournal('E0');                          // deadEpoch E0 (differs from the E1 we heal with)
    seedUser('stub-1', { passwordHash: STUB }); // pure S2S stub on ORIGIN
    flag('stub-1');                             // federation_heal_pending = 1

    // Survivor (local native user) + 1-on-1 DM with the flagged stub.
    testDb.insert(schema.users).values({
      id: 'survivor', username: 'survivor', passwordHash: '$2b$10$localhash',
      homeInstance: null, homeUserId: null, isDeleted: 0, createdAt: Date.now(),
    }).run();
    testDb.insert(schema.dmChannels).values({ id: 'dm_heal', ownerId: null, createdAt: Date.now() }).run();
    testDb.insert(schema.dmMembers).values({ dmChannelId: 'dm_heal', userId: 'stub-1', closed: 0 }).run();
    testDb.insert(schema.dmMembers).values({ dmChannelId: 'dm_heal', userId: 'survivor', closed: 0 }).run();

    const { connectionManager } = await import('../ws/handler.js');
    const sendToUser = connectionManager.sendToUser as ReturnType<typeof vi.fn>;
    sendToUser.mockClear();

    const { healResetIncarnation } = await import('./federationReset.js');
    healResetIncarnation(ORIGIN, 'E1', 'initiate_accepted'); // genuine reset (E0 != E1) → tombstones stub-1

    const call = sendToUser.mock.calls.find(([uid, ev]) => uid === 'survivor' && ev?.type === 'user_updated');
    expect(call).toBeTruthy();
    expect(call![1].user).toMatchObject({ id: 'stub-1', isDeleted: true, username: 'Deleted User' });
  });
});

describe('healResetIncarnation — real-account detach (Phase 2)', () => {
  const QORIGIN = 'orbit.ddns.net';
  let uidCounter = 0;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.clearAllMocks();
    uidCounter = 0;
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedJournal(opts: { origin: string; deadEpoch: string }): void {
    testDb.insert(schema.federationResetEvents).values({
      origin: opts.origin, deadEpoch: opts.deadEpoch, newEpoch: null,
      detectedAt: Date.now(), resolvedAt: null,
      stubCount: 0, orphanedAccountCount: 0,
    }).run();
  }

  function seedRealAccount(opts: { homeInstance: string; username: string; healPending: number }): string {
    const id = `real-${++uidCounter}`;
    testDb.insert(schema.users).values({
      id, username: opts.username, passwordHash: '$2b$10$realbcrypthash',
      homeInstance: opts.homeInstance, homeUserId: id,
      isDeleted: 0, federationHealPending: opts.healPending, createdAt: Date.now(),
    }).run();
    return id;
  }

  function seedSpace(opts: { ownerId: string; name: string }): void {
    testDb.insert(schema.spaces).values({
      id: `space-${opts.ownerId}`, name: opts.name,
      ownerId: opts.ownerId, createdAt: Date.now(),
    }).run();
  }

  it('detaches a flagged real account with NO owned spaces (flag only, username kept)', async () => {
    seedJournal({ origin: QORIGIN, deadEpoch: 'E0' });
    const uid = seedRealAccount({ homeInstance: QORIGIN, username: 'carol@orbit.ddns.net', healPending: 1 });

    const { healResetIncarnation } = await import('./federationReset.js');
    healResetIncarnation(QORIGIN, 'E1', 'initiate_accepted');

    const row = testDb.select().from(schema.users).where(eq(schema.users.id, uid)).get()!;
    expect(row.username).toBe('carol@orbit.ddns.net'); // username PRESERVED — no rename
    expect(row.federationHomeOrphaned).toBe(1);         // detached
    expect(row.federationHealPending).toBe(0);          // processed
    expect(row.isDeleted).toBe(0);                      // NOT deleted (content preserved)
  });

  it('detaches a space-OWNER identically to a non-owner (flag set, username kept)', async () => {
    seedJournal({ origin: QORIGIN, deadEpoch: 'E0' });
    const uid = seedRealAccount({ homeInstance: QORIGIN, username: 'dave@orbit.ddns.net', healPending: 1 });
    seedSpace({ ownerId: uid, name: 'Dave HQ' }); // owns a space — no special case

    const { healResetIncarnation } = await import('./federationReset.js');
    healResetIncarnation(QORIGIN, 'E1', 'initiate_accepted');

    const row = testDb.select().from(schema.users).where(eq(schema.users.id, uid)).get()!;
    expect(row.username).toBe('dave@orbit.ddns.net'); // username PRESERVED (owner treated same as non-owner)
    expect(row.federationHomeOrphaned).toBe(1);        // detached
    expect(row.federationHealPending).toBe(0);         // processed
    expect(row.isDeleted).toBe(0);
    // journal orphaned_account_count reflects the detached set (1)
    const j = testDb.select().from(schema.federationResetEvents)
      .where(eq(schema.federationResetEvents.origin, QORIGIN)).get()!;
    expect(j.orphanedAccountCount).toBe(1);
  });

  it('detaches ALL flagged real accounts and quarantineOrphanedAccounts returns the count', async () => {
    const uid1 = seedRealAccount({ homeInstance: QORIGIN, username: 'erin@orbit.ddns.net', healPending: 1 });
    const uid2 = seedRealAccount({ homeInstance: QORIGIN, username: 'frank@orbit.ddns.net', healPending: 1 });

    const { quarantineOrphanedAccounts } = await import('./federationReset.js');
    const count = quarantineOrphanedAccounts(QORIGIN);

    expect(count).toBe(2); // returns the number of accounts detached
    for (const uid of [uid1, uid2]) {
      const row = testDb.select().from(schema.users).where(eq(schema.users.id, uid)).get()!;
      expect(row.federationHomeOrphaned).toBe(1);
      expect(row.federationHealPending).toBe(0);
    }
  });

  it('false-positive branch (same incarnation) does NOT detach real accounts', async () => {
    seedJournal({ origin: QORIGIN, deadEpoch: 'E0' });
    const uid = seedRealAccount({ homeInstance: QORIGIN, username: 'carol@orbit.ddns.net', healPending: 1 });

    const { healResetIncarnation } = await import('./federationReset.js');
    healResetIncarnation(QORIGIN, 'E0', 'accept_new'); // newEpoch == deadEpoch → false alarm

    const row = testDb.select().from(schema.users).where(eq(schema.users.id, uid)).get()!;
    expect(row.username).toBe('carol@orbit.ddns.net'); // untouched
    expect(row.federationHomeOrphaned ?? 0).toBe(0);    // NOT detached
    expect(row.federationHealPending).toBe(0);          // flags cleared (false-alarm path)
  });
});
