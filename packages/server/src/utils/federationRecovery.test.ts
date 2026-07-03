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

vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));

const onPeerActivated = vi.fn();
vi.mock('./federationPeerActivation.js', () => ({ onPeerActivated }));

const sendToAdmins = vi.fn();
vi.mock('../ws/handler.js', () => ({
  connectionManager: { sendToAdmins, getAllOnlineUserIds: () => [], sendToUser: vi.fn() },
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUnreachable(id: string, attempts = 0, lastProbeAt: number | null = null): void {
  testDb.insert(schema.federationPeers).values({
    id, origin: 'https://peer.example', hmacSecret: 'secret',
    status: 'unreachable', consecutiveFailures: 10,
    probeAttempts: attempts, lastProbeAt,
    lastSyncedAt: Date.now(), createdAt: Date.now(),
  }).run();
}

describe('federationRecovery primitives', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.clearAllMocks();
  });

  it('probePeerReachable returns reachable + parsed instanceId on a 200 from /api/instance/info', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"instanceId":"epoch-x"}', { status: 200 }));
    const { probePeerReachable } = await import('./federationRecovery.js');
    await expect(probePeerReachable('https://peer.example')).resolves.toEqual({ reachable: true, instanceId: 'epoch-x' });
    expect(spy).toHaveBeenCalledWith('https://peer.example/api/instance/info', expect.anything());
  });

  it('probePeerReachable reports null instanceId when the body omits it (legacy peer)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const { probePeerReachable } = await import('./federationRecovery.js');
    await expect(probePeerReachable('https://peer.example')).resolves.toEqual({ reachable: true, instanceId: null });
  });

  it('probePeerReachable reports null instanceId when the body is unparseable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not-json', { status: 200 }));
    const { probePeerReachable } = await import('./federationRecovery.js');
    await expect(probePeerReachable('https://peer.example')).resolves.toEqual({ reachable: true, instanceId: null });
  });

  it('probePeerReachable returns not-reachable on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 502 }));
    const { probePeerReachable } = await import('./federationRecovery.js');
    await expect(probePeerReachable('https://peer.example')).resolves.toEqual({ reachable: false, instanceId: null });
  });

  it('probePeerReachable returns not-reachable on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));
    const { probePeerReachable } = await import('./federationRecovery.js');
    await expect(probePeerReachable('https://peer.example')).resolves.toEqual({ reachable: false, instanceId: null });
  });

  it('markPeerRecovered flips status to active, resets pacing + counters, calls onPeerActivated', async () => {
    seedUnreachable('peer-rec', 3, Date.now());
    const { markPeerRecovered } = await import('./federationRecovery.js');
    await markPeerRecovered('peer-rec');
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-rec')).get()!;
    expect(row.status).toBe('active');
    expect(row.consecutiveFailures).toBe(0);
    expect(row.probeAttempts).toBe(0);
    expect(row.lastProbeAt).toBeNull();
    expect(row.lastSeenAt).toBeGreaterThan(0);
    expect(onPeerActivated).toHaveBeenCalledWith('peer-rec', 'health_check_recovery');
  });

  it('recoverOrDetectReset recovers when the probed epoch matches the trusted baseline', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-match', origin: 'https://peer.example', hmacSecret: 'secret',
      status: 'unreachable', consecutiveFailures: 5, probeAttempts: 2, lastProbeAt: Date.now(),
      peerInstanceId: 'E0', lastSyncedAt: Date.now(), createdAt: Date.now(),
    }).run();
    const { recoverOrDetectReset } = await import('./federationRecovery.js');
    const outcome = await recoverOrDetectReset(
      { id: 'peer-match', origin: 'https://peer.example', peerInstanceId: 'E0' },
      { reachable: true, instanceId: 'E0' },
    );
    expect(outcome).toBe('recovered');
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-match')).get()!;
    expect(row.status).toBe('active');
    expect(onPeerActivated).toHaveBeenCalledWith('peer-match', 'health_check_recovery');
  });

  it('recoverOrDetectReset recovers when the baseline is null (never-tracked / legacy)', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-null', origin: 'https://peer.example', hmacSecret: 'secret',
      status: 'unreachable', consecutiveFailures: 5, probeAttempts: 2, lastProbeAt: Date.now(),
      peerInstanceId: null, lastSyncedAt: Date.now(), createdAt: Date.now(),
    }).run();
    const { recoverOrDetectReset } = await import('./federationRecovery.js');
    const outcome = await recoverOrDetectReset(
      { id: 'peer-null', origin: 'https://peer.example', peerInstanceId: null },
      { reachable: true, instanceId: 'E9' },
    );
    expect(outcome).toBe('recovered');
    expect(testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-null')).get()!.status).toBe('active');
  });

  it('recoverOrDetectReset routes to needs_attention (does NOT recover) when the probed epoch differs', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-reset', origin: 'https://peer.example', hmacSecret: 'secret',
      status: 'unreachable', consecutiveFailures: 5, probeAttempts: 2, lastProbeAt: Date.now(),
      peerInstanceId: 'E0', lastSyncedAt: Date.now(), createdAt: Date.now(),
    }).run();
    const { recoverOrDetectReset } = await import('./federationRecovery.js');
    const outcome = await recoverOrDetectReset(
      { id: 'peer-reset', origin: 'https://peer.example', peerInstanceId: 'E0' },
      { reachable: true, instanceId: 'E1' },
    );
    expect(outcome).toBe('reset_detected');
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-reset')).get()!;
    expect(row.status).toBe('needs_attention');
    expect(row.needsAttentionReason).toBe('peer_reset_detected');
    expect(row.peerInstanceId).toBe('E0'); // trusted baseline untouched
    expect(row.hmacSecret).toBe('secret'); // never rekeyed
    // A reset peer must NOT be recovered to active.
    expect(onPeerActivated).not.toHaveBeenCalled();
  });

  // ── detectResetOnNeedsAttentionPeers (design §4.1) ─────────────────────────
  // Closes the auth-failure sub-case: a reset peer whose HTTP is up (returning
  // 401/403 because the new incarnation has no peer row for us) crosses
  // AUTH_FAILURE_THRESHOLD and lands in `needs_attention` WITHOUT ever passing
  // through `unreachable`, so the unreachable-only recovery probe never observes
  // its epoch change. This pass probes those peers too — detection ONLY, never a
  // recover-to-active.
  function seedNeedsAttention(id: string, reason: string | null, peerInstanceId: string | null): void {
    testDb.insert(schema.federationPeers).values({
      id, origin: 'https://peer.example', hmacSecret: 'secret',
      status: 'needs_attention', needsAttentionReason: reason,
      peerInstanceId, consecutiveFailures: 0,
      lastSyncedAt: Date.now(), createdAt: Date.now(),
    }).run();
  }

  it('detectResetOnNeedsAttentionPeers flags an auth-failure peer whose epoch changed (detection only)', async () => {
    seedNeedsAttention('peer-na', 'auth_failures', 'E0');
    // A pure replicated stub belonging to the dead incarnation (bare-domain home).
    testDb.insert(schema.users).values({
      id: 'stub-1', username: 'carol', displayName: 'carol',
      passwordHash: '!federation-replicated', homeInstance: 'peer.example',
      createdAt: Date.now(),
    }).run();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"instanceId":"E1"}', { status: 200 }));

    const { detectResetOnNeedsAttentionPeers } = await import('./federationRecovery.js');
    await detectResetOnNeedsAttentionPeers();

    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-na')).get()!;
    expect(row.status).toBe('needs_attention'); // NOT flipped to active
    expect(row.needsAttentionReason).toBe('peer_reset_detected');
    expect(row.observedPeerInstanceId).toBe('E1'); // observed epoch recorded
    expect(row.peerInstanceId).toBe('E0'); // trusted baseline untouched
    expect(row.hmacSecret).toBe('secret'); // secret untouched

    const journal = testDb.select().from(schema.federationResetEvents)
      .where(eq(schema.federationResetEvents.origin, 'https://peer.example')).get()!;
    expect(journal.deadEpoch).toBe('E0');
    expect(journal.resolvedAt).toBeNull();

    const stub = testDb.select().from(schema.users)
      .where(eq(schema.users.id, 'stub-1')).get()!;
    expect(stub.federationHealPending).toBe(1); // dead incarnation snapshotted

    expect(onPeerActivated).not.toHaveBeenCalled(); // detection only
  });

  it('detectResetOnNeedsAttentionPeers is a no-op when the probed epoch matches the baseline', async () => {
    seedNeedsAttention('peer-same', 'auth_failures', 'E0');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"instanceId":"E0"}', { status: 200 }));

    const { detectResetOnNeedsAttentionPeers } = await import('./federationRecovery.js');
    await detectResetOnNeedsAttentionPeers();

    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-same')).get()!;
    expect(row.status).toBe('needs_attention');
    expect(row.needsAttentionReason).toBe('auth_failures'); // unchanged
    expect(testDb.select().from(schema.federationResetEvents).all()).toHaveLength(0);
    expect(onPeerActivated).not.toHaveBeenCalled();
  });

  it('detectResetOnNeedsAttentionPeers skips peers already flagged peer_reset_detected (no probe)', async () => {
    seedNeedsAttention('peer-done', 'peer_reset_detected', 'E0');
    const spy = vi.spyOn(globalThis, 'fetch');

    const { detectResetOnNeedsAttentionPeers } = await import('./federationRecovery.js');
    await detectResetOnNeedsAttentionPeers();

    expect(spy).not.toHaveBeenCalled(); // already journaled — not re-probed
  });

  it('detectResetOnNeedsAttentionPeers skips peers with a null baseline (nothing to compare)', async () => {
    seedNeedsAttention('peer-nobase', 'auth_failures', null);
    const spy = vi.spyOn(globalThis, 'fetch');

    const { detectResetOnNeedsAttentionPeers } = await import('./federationRecovery.js');
    await detectResetOnNeedsAttentionPeers();

    expect(spy).not.toHaveBeenCalled(); // no trusted baseline → cannot detect a change
  });

  // ── detectResetForPeer (per-peer unit) ─────────────────────────────────────
  // The shared single-peer probe fired the instant a peer crosses into
  // needs_attention via the auth-failure path (event-driven, in federationWorker)
  // and by the worker-startup sweep — collapsing reset-detection latency from a
  // 15-minute health-check cycle to one /instance/info GET.

  it('detectResetForPeer returns true and journals the reset when the probed epoch differs', async () => {
    seedNeedsAttention('peer-evt', 'auth_failures', 'E0');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"instanceId":"E1"}', { status: 200 }));

    const { detectResetForPeer } = await import('./federationRecovery.js');
    const detected = await detectResetForPeer({ id: 'peer-evt', origin: 'https://peer.example', peerInstanceId: 'E0' });

    expect(detected).toBe(true);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-evt')).get()!;
    expect(row.status).toBe('needs_attention'); // detection only — never flipped to active
    expect(row.needsAttentionReason).toBe('peer_reset_detected');
    expect(row.observedPeerInstanceId).toBe('E1');
    expect(row.peerInstanceId).toBe('E0'); // trusted baseline untouched
    expect(row.hmacSecret).toBe('secret'); // never rekeyed
    expect(testDb.select().from(schema.federationResetEvents)
      .where(eq(schema.federationResetEvents.origin, 'https://peer.example')).get()!.resolvedAt).toBeNull();
    expect(onPeerActivated).not.toHaveBeenCalled();
  });

  it('detectResetForPeer returns false and is a no-op when the probed epoch matches the baseline', async () => {
    seedNeedsAttention('peer-evt-same', 'auth_failures', 'E0');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"instanceId":"E0"}', { status: 200 }));

    const { detectResetForPeer } = await import('./federationRecovery.js');
    const detected = await detectResetForPeer({ id: 'peer-evt-same', origin: 'https://peer.example', peerInstanceId: 'E0' });

    expect(detected).toBe(false);
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-evt-same')).get()!;
    expect(row.needsAttentionReason).toBe('auth_failures'); // unchanged
    expect(testDb.select().from(schema.federationResetEvents).all()).toHaveLength(0);
  });

  it('detectResetForPeer returns false WITHOUT probing when the baseline is null', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const { detectResetForPeer } = await import('./federationRecovery.js');
    const detected = await detectResetForPeer({ id: 'peer-evt-nobase', origin: 'https://peer.example', peerInstanceId: null });

    expect(detected).toBe(false);
    expect(spy).not.toHaveBeenCalled(); // no baseline → cannot detect a change, no wasted GET
  });

  it('detectResetForPeer returns false when the peer is unreachable (no false reset)', async () => {
    seedNeedsAttention('peer-evt-down', 'auth_failures', 'E0');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));

    const { detectResetForPeer } = await import('./federationRecovery.js');
    const detected = await detectResetForPeer({ id: 'peer-evt-down', origin: 'https://peer.example', peerInstanceId: 'E0' });

    expect(detected).toBe(false);
    expect(testDb.select().from(schema.federationResetEvents).all()).toHaveLength(0);
    expect(testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-evt-down')).get()!.needsAttentionReason).toBe('auth_failures');
  });
});
