import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';
import { remotePeerStub, jsonResponse } from '../testing/remotePeerStub.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('dns', () => ({
  default: { promises: { lookup: async () => ({ address: '93.184.216.34', family: 4 }) } },
}));

vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));

vi.mock('./federationAuth.js', async () => {
  const actual = await vi.importActual<typeof import('./federationAuth.js')>('./federationAuth.js');
  return { ...actual, getOurOrigin: () => 'https://local.example', generateHmacSecret: () => 'our-secret' };
});

vi.mock('../routes/federation.js', () => ({
  validateOrigin: (raw: string) => {
    try { return new URL(raw).origin; } catch { return null; }
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: { sendToAdmins: vi.fn(), sendToUser: vi.fn(), getAllOnlineUserIds: () => [] },
}));

vi.mock('./federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(async () => undefined),
  onPeerDeactivated: vi.fn(async () => undefined),
}));

const REMOTE = 'https://remote.example';

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function peerRow(): typeof schema.federationPeers.$inferSelect | undefined {
  return testDb.select().from(schema.federationPeers).where(eq(schema.federationPeers.origin, REMOTE)).get();
}

const existsAnswer = (): Response => jsonResponse({
  accepted: false,
  code: 'PEER_EXISTS_RESET_REQUIRED',
  error: 'This instance already holds peering for you',
}, 409);

beforeEach(async () => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  testDb.insert(schema.instanceSettings).values({
    id: 1, instanceName: 'Local', instanceId: 'local-epoch', autoAcceptPeering: 1, registrationOpen: 1, updatedAt: Date.now(),
  }).run();
  const { _clearInFlightPeering } = await import('./federationPeering.js');
  _clearInFlightPeering();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sqlite.close();
});

describe('a 409 PEER_EXISTS_RESET_REQUIRED answer (#309)', () => {
  it('parks the row as rejected / stale_peering_on_remote and does not send again', async () => {
    const remote = remotePeerStub({ accept: existsAnswer, epoch: 'mismatch' });
    const fetchMock = vi.fn(remote);
    vi.stubGlobal('fetch', fetchMock);

    const { ensurePeered } = await import('./federationPeering.js');
    const first = await ensurePeered(REMOTE, { kind: 'system' });

    expect(first.status).toBe('rejected');
    expect(peerRow()?.status).toBe('rejected');
    expect(peerRow()?.statusReason).toBe('stale_peering_on_remote');

    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await ensurePeered(REMOTE, { kind: 'system' });
    expect(second.status).toBe('rejected');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('activates when the signed /epoch shows the remote already holds our secret (an earlier answer was lost)', async () => {
    vi.stubGlobal('fetch', remotePeerStub({ accept: existsAnswer, instanceId: 'remote-epoch' }));

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered(REMOTE, { kind: 'system' });

    expect(result.status).toBe('active');
    expect(peerRow()?.status).toBe('active');
    expect(peerRow()?.peerInstanceId).toBe('remote-epoch');
  });
});

describe('the parked-row backstop (resolveStaleParkedPeers)', () => {
  function seedParked(): void {
    testDb.insert(schema.federationPeers).values({
      id: 'parked', origin: REMOTE, hmacSecret: 'our-secret', status: 'rejected',
      statusReason: 'stale_peering_on_remote', initiatedBy: 'auto', createdAt: Date.now(),
    }).run();
  }

  it('activates the row when the remote now holds our secret', async () => {
    seedParked();
    // The remote holds our secret now: its signed /epoch verifies with it.
    const stub = remotePeerStub({ accept: existsAnswer, instanceId: 'remote-epoch' });
    await stub(`${REMOTE}/api/federation/peer/accept`, { method: 'POST', body: JSON.stringify({ hmacSecret: 'our-secret' }) });
    vi.stubGlobal('fetch', stub);

    const { resolveStaleParkedPeers } = await import('./federationPeering.js');
    await resolveStaleParkedPeers();

    expect(peerRow()?.status).toBe('active');
    expect(peerRow()?.statusReason).toBeNull();
  });

  it('sends one handshake when the remote holds no row for us any more, and it lands', async () => {
    seedParked();
    let adopted = false;
    const verified = remotePeerStub({ accept: () => { adopted = true; return jsonResponse({ accepted: true }); } });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      // First /epoch: 403 (no row). The handshake is then accepted, and the
      // second /epoch (verify-before-activate) verifies the adopted secret.
      if (String(url).endsWith('/api/federation/epoch') && !adopted) {
        return new Response('{"error":"Not peered"}', { status: 403 });
      }
      return verified(url, init);
    }));

    const { resolveStaleParkedPeers } = await import('./federationPeering.js');
    await resolveStaleParkedPeers();

    expect(adopted).toBe(true);
    expect(peerRow()?.status).toBe('active');
  });

  it('stays parked, with no handshake, while the remote still holds its older row (401)', async () => {
    seedParked();
    const fetchMock = vi.fn(remotePeerStub({ accept: existsAnswer, epoch: 'mismatch' }));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveStaleParkedPeers } = await import('./federationPeering.js');
    await resolveStaleParkedPeers();

    expect(peerRow()?.status).toBe('rejected');
    expect(fetchMock.mock.calls.map(c => String(c[0]))).toEqual([`${REMOTE}/api/federation/epoch`]);
  });
});

describe('answers that arrive after the row changed (#323)', () => {
  it('a 202 does not downgrade a row the remote activated while our request was in flight', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      testDb.update(schema.federationPeers).set({ status: 'active', hmacSecret: 'their-secret' })
        .where(eq(schema.federationPeers.origin, REMOTE)).run();
      return jsonResponse({ queued: true, approvalToken: 'tok' }, 202);
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered(REMOTE, { kind: 'system' });

    expect(peerRow()?.status).toBe('active');
    expect(result.status).toBe('active');
  });

  it('with a remote that took both concurrent handshakes, adopts the secret the remote verifiably holds', async () => {
    // A release without the concurrent-handshake rule: its /peer/accept to us
    // lands while ours is in flight (we take its secret), then it takes ours too.
    const remote = remotePeerStub({ accept: () => {
      testDb.update(schema.federationPeers).set({ status: 'active', hmacSecret: 'their-secret' })
        .where(eq(schema.federationPeers.origin, REMOTE)).run();
      return jsonResponse({ accepted: true });
    } });
    vi.stubGlobal('fetch', remote);

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered(REMOTE, { kind: 'system' });

    expect(result.status).toBe('active');
    expect(peerRow()?.hmacSecret).toBe('our-secret');
  });

  it('a 409 PEER_HANDSHAKE_IN_PROGRESS leaves the row for the remote handshake to settle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: 'in progress', code: 'PEER_HANDSHAKE_IN_PROGRESS',
    }, 409)));

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered(REMOTE, { kind: 'system' });

    expect(result.status).toBe('failed');
    expect(peerRow()?.status).toBe('pending');
    expect(peerRow()?.probeAttempts).toBe(1);
  });
});

describe('verify-before-activate on the auto-peering path', () => {
  it('parks a 200 whose secret the signed /epoch cannot verify in needs_attention / repeer_incomplete', async () => {
    vi.stubGlobal('fetch', remotePeerStub({ accept: () => jsonResponse({ accepted: true }), epoch: 'mismatch' }));

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered(REMOTE, { kind: 'system' });

    expect(result.status).toBe('rejected');
    expect(peerRow()?.status).toBe('needs_attention');
    expect(peerRow()?.statusReason).toBe('repeer_incomplete');
  });

  it('stores the verified epoch as the baseline, not the unverified one in the 200 body', async () => {
    vi.stubGlobal('fetch', remotePeerStub({
      accept: () => jsonResponse({ accepted: true, instanceId: 'body-epoch' }),
      instanceId: 'signed-epoch',
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    await ensurePeered(REMOTE, { kind: 'system' });

    expect(peerRow()?.peerInstanceId).toBe('signed-epoch');
  });
});

describe('pacing: every failed handshake counts (#322)', () => {
  it('a failed handshake started outside the worker advances probe_attempts on the row it keeps', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'kept', origin: REMOTE, hmacSecret: 'our-secret', status: 'pending', initiatedBy: 'auto', createdAt: Date.now(),
    }).run();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

    const { ensurePeered } = await import('./federationPeering.js');
    await ensurePeered(REMOTE, { kind: 'system' });

    expect(peerRow()?.probeAttempts).toBe(1);
    expect(peerRow()?.lastProbeAt).not.toBeNull();
  });
});
