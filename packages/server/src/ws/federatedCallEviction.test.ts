import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://local.example',
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

async function importManager() {
  const mod = await import('./handler.js');
  return mod.connectionManager;
}

type FedCallEntry = import('./handler.js').FederatedCallEntry;

function makeFedCall(partial: Partial<FedCallEntry> = {}): FedCallEntry {
  return {
    dmChannelId: 'dm-1',
    federatedId: `fed-${Math.random().toString(36).slice(2, 10)}`,
    callerId: 'caller-user',
    callerHomeUserId: 'caller-home',
    federatedCallHost: 'https://hostA.example',
    livekitUrl: 'wss://lk.example',
    tokens: new Map([['caller-home', 'tok']]),
    ringedUserIds: ['user-1', 'user-2'],
    state: 'active',
    startedAt: Date.now(),
    ...partial,
  };
}

let sqlite: Database.Database;

describe('ConnectionManager.evictFederatedCallsForHost', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);

    const cm = await importManager();
    // Reset federatedCalls between tests — use the public API.
    for (const [fedId] of cm.getAllFederatedCalls()) {
      cm.clearFederatedCall(fedId);
    }
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    sqlite.close();
  });

  it('emits dm_call_undeliverable with host_unreachable to every ringed user and clears entries', async () => {
    const cm = await importManager();
    const sendSpy = vi.spyOn(cm, 'sendToUser').mockImplementation(() => undefined);

    const ringing = makeFedCall({
      federatedId: 'fed-ringing',
      state: 'ringing',
      ringedUserIds: ['alice', 'bob'],
      federatedCallHost: 'https://hostA.example',
    });
    const active = makeFedCall({
      federatedId: 'fed-active',
      state: 'active',
      ringedUserIds: ['carol'],
      federatedCallHost: 'https://hostA.example',
    });
    cm.createFederatedCall(ringing);
    cm.createFederatedCall(active);

    const count = cm.evictFederatedCallsForHost('https://hostA.example', {
      reason: 'peer_transient_failure',
      peerLabel: 'Host A',
    });

    expect(count).toBe(2);

    // 3 users total × 1 event each
    expect(sendSpy).toHaveBeenCalledTimes(3);
    const userIds = sendSpy.mock.calls.map(c => c[0]);
    expect(userIds.sort()).toEqual(['alice', 'bob', 'carol']);

    for (const call of sendSpy.mock.calls) {
      const ev = call[1] as Record<string, unknown>;
      expect(ev.type).toBe('dm_call_undeliverable');
      expect(ev.phase).toBe('host_unreachable');
      expect(ev.terminal).toBe(true);
      const failures = ev.failures as Array<{ reason: string; peerOrigin: string; peerLabel?: string }>;
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        reason: 'peer_transient_failure',
        peerOrigin: 'https://hostA.example',
        peerLabel: 'Host A',
      });
    }

    expect(cm.getFederatedCall('fed-ringing')).toBeUndefined();
    expect(cm.getFederatedCall('fed-active')).toBeUndefined();
  });

  it('leaves entries pointing at a different host untouched', async () => {
    const cm = await importManager();
    vi.spyOn(cm, 'sendToUser').mockImplementation(() => undefined);

    cm.createFederatedCall(makeFedCall({
      federatedId: 'fed-A',
      federatedCallHost: 'https://hostA.example',
    }));
    cm.createFederatedCall(makeFedCall({
      federatedId: 'fed-B',
      federatedCallHost: 'https://hostB.example',
    }));

    const count = cm.evictFederatedCallsForHost('https://hostA.example', {
      reason: 'peer_rejected',
    });

    expect(count).toBe(1);
    expect(cm.getFederatedCall('fed-A')).toBeUndefined();
    expect(cm.getFederatedCall('fed-B')).toBeDefined();
  });

  it('is idempotent — second call for the same host returns 0 and broadcasts nothing new', async () => {
    const cm = await importManager();
    const sendSpy = vi.spyOn(cm, 'sendToUser').mockImplementation(() => undefined);

    cm.createFederatedCall(makeFedCall({
      federatedId: 'fed-once',
      ringedUserIds: ['u-1'],
      federatedCallHost: 'https://hostA.example',
    }));

    const first = cm.evictFederatedCallsForHost('https://hostA.example', {
      reason: 'peer_transient_failure',
    });
    const second = cm.evictFederatedCallsForHost('https://hostA.example', {
      reason: 'peer_transient_failure',
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels the 60s ring timer on eviction so no late dm_call_ended fires', async () => {
    const cm = await importManager();
    const sendSpy = vi.spyOn(cm, 'sendToUser').mockImplementation(() => undefined);

    cm.createFederatedCall(makeFedCall({
      federatedId: 'fed-ringing',
      state: 'ringing',
      ringedUserIds: ['u-ring'],
      federatedCallHost: 'https://hostA.example',
    }));

    cm.evictFederatedCallsForHost('https://hostA.example', { reason: 'peer_transient_failure' });

    // Advance past the 60s ring-timeout; if the timer is still armed we'd see
    // a late 'dm_call_ended' broadcast.
    vi.advanceTimersByTime(61_000);

    const dmCallEndedCalls = sendSpy.mock.calls.filter(c => {
      const ev = c[1] as Record<string, unknown>;
      return ev.type === 'dm_call_ended';
    });
    expect(dmCallEndedCalls).toHaveLength(0);
  });
});
