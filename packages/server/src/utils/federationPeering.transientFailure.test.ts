import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

// The peer-origin gate resolves an asserted origin before this instance will
// send anything to it. This suite is about what a failed handshake leaves
// behind, not address policy, so the resolver answers with a public address.
vi.mock('dns', () => ({
  default: { promises: { lookup: async () => ({ address: '93.184.216.34', family: 4 }) } },
}));

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('./federationAuth.js', async () => {
  const actual = await vi.importActual<typeof import('./federationAuth.js')>('./federationAuth.js');
  return {
    ...actual,
    getOurOrigin: () => 'https://local.example',
    generateHmacSecret: () => 'mock-hmac-secret',
  };
});

vi.mock('../routes/federation.js', () => ({
  validateOrigin: (raw: string) => {
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    sendToUser: vi.fn(),
    getAllOnlineUserIds: () => [],
  },
}));

vi.mock('./federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(async () => undefined),
  onPeerDeactivated: vi.fn(async () => undefined),
}));

const REMOTE = 'https://remote.example';

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
    instanceId: 'test-epoch-local',
    autoAcceptPeering: 1,
    registrationOpen: 1,
    updatedAt: Date.now(),
  }).run();
}

function peerRow(): typeof schema.federationPeers.$inferSelect | undefined {
  return testDb.select().from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, REMOTE)).get();
}

function outboxEntityIds(): string[] {
  return testDb.select({ entityId: schema.federationOutbox.entityId })
    .from(schema.federationOutbox).all().map(r => r.entityId);
}

/**
 * What `queueOutboxEvent` does when a DM is sent while the handshake is in
 * flight: it finds the handshake's `pending` row and queues against it. In the
 * DM send path this is the normal order, because the typing-stop relay's
 * warm-up (`sendCallRelay` with `peeringTimeoutMs: 0`) starts the handshake
 * before `queueDmRelay` runs.
 */
function queueAgainstPendingRow(entityId: string): void {
  const peer = peerRow();
  if (!peer) throw new Error('handshake created no pending row to queue against');
  const now = Date.now();
  testDb.insert(schema.federationOutbox).values({
    id: `outbox-${entityId}`,
    peerId: peer.id,
    contextId: 'dm-1',
    entityId,
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

describe('performHandshake — a transient failure keeps a row that local traffic has queued against', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    const { _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('network error: the pending row and the message queued during the handshake both survive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      queueAgainstPendingRow('msg-1');
      throw new TypeError('fetch failed');
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered(REMOTE, { kind: 'system' });

    expect(result.status).toBe('failed');
    const row = peerRow();
    expect(row?.status).toBe('pending');
    expect(row?.initiatedBy).toBe('auto');
    expect(outboxEntityIds()).toEqual(['msg-1']);
  });

  it('non-2xx answer: the pending row and the queued message both survive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      queueAgainstPendingRow('msg-2');
      return new Response(JSON.stringify({ error: 'upstream down' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered(REMOTE, { kind: 'system' });

    expect(result.status).toBe('failed');
    expect(peerRow()?.status).toBe('pending');
    expect(outboxEntityIds()).toEqual(['msg-2']);
  });

  it('control: with nothing queued, the pending row the handshake created is removed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered(REMOTE, { kind: 'system' });

    expect(result.status).toBe('failed');
    expect(peerRow()).toBeUndefined();
  });

  it('control: the worker retries the surviving row and the queued message stays for delivery', async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        queueAgainstPendingRow('msg-3');
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify({ accepted: true, instanceName: 'Remote' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { ensurePeered } = await import('./federationPeering.js');
    expect((await ensurePeered(REMOTE, { kind: 'system' })).status).toBe('failed');
    // The outbox worker's resolvePendingPeers() retries exactly this shape:
    // a pending row with queued entries.
    expect((await ensurePeered(REMOTE, { kind: 'system' })).status).toBe('active');

    expect(peerRow()?.status).toBe('active');
    expect(outboxEntityIds()).toEqual(['msg-3']);
  });
});

/**
 * What the remote's own `/peer/accept` does to our row when it lands while our
 * handshake is in flight (`peerHandshake.ts`, "Pending — update with new secret
 * and activate"): the same row, now `active` under the remote's secret.
 */
function promotePendingRowAsRemoteAcceptWould(): void {
  const peer = peerRow();
  if (!peer) throw new Error('handshake created no pending row to promote');
  testDb.update(schema.federationPeers)
    .set({ status: 'active', hmacSecret: 'secret-from-remote-accept', lastSeenAt: Date.now() })
    .where(eq(schema.federationPeers.id, peer.id))
    .run();
}

describe('performHandshake — the remote activates our row while our handshake is in flight', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    const { _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('a failed request does not delete the row the remote promoted to active', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      promotePendingRowAsRemoteAcceptWould();
      throw new TypeError('fetch failed');
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    await ensurePeered(REMOTE, { kind: 'system' });

    const row = peerRow();
    expect(row?.status).toBe('active');
    expect(row?.hmacSecret).toBe('secret-from-remote-accept');
  });

  it('with entries queued, the kept-row log reports the row as active, not pending', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => {
      queueAgainstPendingRow('msg-4');
      promotePendingRowAsRemoteAcceptWould();
      throw new TypeError('fetch failed');
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    await ensurePeered(REMOTE, { kind: 'system' });

    expect(peerRow()?.status).toBe('active');
    expect(outboxEntityIds()).toEqual(['msg-4']);
    const lines = log.mock.calls.map(args => String(args[0]));
    expect(lines.some(l => l.includes('pending row'))).toBe(false);
    expect(lines.some(l => l.includes(REMOTE) && l.includes('active'))).toBe(true);
  });
});

describe('performHandshake — a remote that has revoked us is a settled answer', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    const { _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sqlite.close();
  });

  /** The remote's answer when its row for us is `revoked` (peerHandshake.ts). */
  function revokedAnswer(): Response {
    return new Response(JSON.stringify({ error: 'Peering with this instance has been revoked', statusCode: 403 }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('settles the row as rejected, the way 403 PEERING_REQUIRES_APPROVAL does', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      queueAgainstPendingRow('msg-5');
      return revokedAnswer();
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    const { onPeerDeactivated } = await import('./federationPeerActivation.js');
    const result = await ensurePeered(REMOTE, { kind: 'system' });

    expect(result).toEqual({ status: 'rejected', error: 'Peering with this instance has been revoked' });
    const row = peerRow();
    expect(row?.status).toBe('rejected');
    expect(onPeerDeactivated).toHaveBeenCalledWith(row?.id, 'remote_rejected');
  });

  it('is not retried: the next ensurePeered answers from the row without a request', async () => {
    const fetchMock = vi.fn(async () => {
      queueAgainstPendingRow('msg-6');
      return revokedAnswer();
    });
    vi.stubGlobal('fetch', fetchMock);

    const { ensurePeered } = await import('./federationPeering.js');
    await ensurePeered(REMOTE, { kind: 'system' });
    const second = await ensurePeered(REMOTE, { kind: 'system' });

    expect(second.status).toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a row the remote promoted to active during the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      promotePendingRowAsRemoteAcceptWould();
      return revokedAnswer();
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered(REMOTE, { kind: 'system' });

    const row = peerRow();
    expect(row?.status).toBe('active');
    expect(result).toEqual({ status: 'active', peerId: row?.id });
  });
});
