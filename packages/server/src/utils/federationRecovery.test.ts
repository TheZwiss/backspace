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
});
