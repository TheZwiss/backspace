import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

// Relay off: the mutation-log sync is a no-op, so the activation reaches the
// record pass and the presence snapshot without any network.
vi.mock('./federationOutbox.js', () => ({
  isFederationRelayEnabled: () => false,
}));

vi.mock('./federationAuth.js', () => ({
  getOurOrigin: () => 'https://local.example',
  buildFederationHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    sendToUser: vi.fn(),
    getAllOnlineUserIds: () => [],
    sendToDmMembers: vi.fn(),
    evictFederatedCallsForHost: vi.fn().mockReturnValue(0),
  },
}));

const recordPass = vi.fn<(origin: string) => Promise<void>>();
vi.mock('./federationStubBackfill.js', () => ({
  backfillStubUsernamesForPeer: (origin: string) => recordPass(origin),
}));

const presenceSnapshot = vi.fn<(origin: string) => Promise<void>>();
vi.mock('./federationPresence.js', () => ({
  snapshotPresenceForPeer: (origin: string) => presenceSnapshot(origin),
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const ORIGIN = 'https://peer-r.example';

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  recordPass.mockReset();
  presenceSnapshot.mockReset();
  presenceSnapshot.mockResolvedValue(undefined);
  testDb.insert(schema.federationPeers).values({
    id: 'peer-r', origin: ORIGIN, hmacSecret: 'secret',
    status: 'active', lastSyncedAt: 1, createdAt: Date.now(),
  }).run();
});

describe('onPeerActivated and the record pass', () => {
  it('sends the presence snapshot without waiting for the record pass', async () => {
    let release: () => void = () => undefined;
    recordPass.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const { onPeerActivated } = await import('./federationPeerActivation.js');

    await onPeerActivated('peer-r', 'health_check_recovery');

    expect(recordPass).toHaveBeenCalledWith(ORIGIN);
    expect(presenceSnapshot).toHaveBeenCalledWith(ORIGIN);
    release();
  });

  it('logs a failed record pass and still completes the activation', async () => {
    const failure = new Error('pass failed');
    recordPass.mockRejectedValue(failure);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { onPeerActivated } = await import('./federationPeerActivation.js');
    const { connectionManager } = await import('../ws/handler.js');

    await expect(onPeerActivated('peer-r', 'health_check_recovery')).resolves.toBeUndefined();

    expect(presenceSnapshot).toHaveBeenCalledWith(ORIGIN);
    expect(connectionManager.sendToAdmins).toHaveBeenCalledWith({ type: 'federation_peers_changed' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[onPeerActivated] backfillStubUsernamesForPeer(%s) failed',
      ORIGIN,
      failure,
    ));
    warn.mockRestore();
  });
});
