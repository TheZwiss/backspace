import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
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
      const url = new URL(raw);
      return url.origin;
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
    autoAcceptPeering: 1,
    registrationOpen: 1,
    updatedAt: Date.now(),
  }).run();
}

describe('ensurePeered — refuses when unresolved inbound approval-request exists', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('returns rejected when a peer_approval_requests row exists for the target origin, even if no peer row exists', async () => {
    const now = Date.now();
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'approval-1',
      origin: 'https://orbit.test',
      instanceName: 'Orbit',
      hmacSecret: 'a'.repeat(64),
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { ensurePeered, _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
    const result = await ensurePeered('https://orbit.test', { kind: 'system' });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toMatch(/admin must resolve/i);
    }

    // Refusal is BEFORE performHandshake — no peer row created, no outbound POST.
    const peers = testDb.select().from(schema.federationPeers).all();
    expect(peers).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not block when there is no inbound approval-request', async () => {
    // No approval-request row, no existing peer. Should proceed to performHandshake.
    // Stub fetch with a network failure so the handshake resolves as 'failed'
    // (transient) rather than reaching any 4xx/5xx branches.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));

    const { ensurePeered, _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
    const result = await ensurePeered('https://nopeer.test', { kind: 'system' });

    // Reached performHandshake — failure mode is 'failed' (network), NOT
    // the pre-handshake 'rejected' from the new guard.
    expect(result.status).not.toBe('rejected');
    expect(result.status).toBe('failed');
  });
});
