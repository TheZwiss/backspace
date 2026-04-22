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

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
  },
}));

vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://test.example',
  buildFederationHeaders: () => ({ 'Content-Type': 'application/json' }),
  generateHmacSecret: () => 'secret',
  ROTATION_GRACE_PERIOD_MS: 15 * 60 * 1000,
}));

vi.mock('../utils/federationOutbox.js', () => ({
  isFederationRelayEnabled: () => true,
  queueOutboxEvent: vi.fn(),
  appendMutationLog: vi.fn(),
}));

vi.mock('../utils/federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(),
  startupBootstrapSync: vi.fn(),
}));

vi.mock('../utils/storageJanitor.js', () => ({
  runFederationJanitor: vi.fn(),
}));

vi.mock('../utils/thumbnail.js', () => ({
  generateThumbnail: vi.fn(),
}));

vi.mock('../routes/dm.js', () => ({
  getDmMessageWithUser: vi.fn(),
}));

vi.mock('../utils/federationAuthFailure.js', () => ({
  evaluateAuthFailure: vi.fn().mockReturnValue({ kind: 'increment', newAuthFailures: 1 }),
  AUTH_FAILURE_THRESHOLD: 5,
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

function seedPeer(id: string): void {
  testDb.insert(schema.federationPeers).values({
    id, origin: 'https://peer.example', hmacSecret: 'secret',
    status: 'active', lastSyncedAt: Date.now(), createdAt: Date.now(),
  }).run();
}

function seedOutboxEntry(id: string, peerId: string, entityId: string): void {
  testDb.insert(schema.federationOutbox).values({
    id, peerId, contextId: 'ch-1', entityId,
    contextType: 'dm', eventType: 'create', payload: JSON.stringify({
      message: { userId: 'u', homeUserId: 'u', homeInstance: 'test.example', content: 'hi', replyToId: null, editedAt: null, createdAt: Date.now() },
    }),
    encryptionVersion: 0, attempts: 0, nextRetryAt: Date.now() - 1000,
    expiresAt: Date.now() + 30 * 86_400_000,
    createdAt: Date.now(),
  }).run();
}

describe('outbox worker — duplicate rejection is terminal', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.restoreAllMocks();
    // Re-apply the static mocks that vi.restoreAllMocks() would undo.
    // isFederationRelayEnabled is mocked at module level via vi.mock (hoisted),
    // so it survives restoreAllMocks — spies created with vi.spyOn are the ones
    // that get restored. The fetch spy is re-created per test via mockImplementation.
  });

  it('deletes the outbox entry when the peer responds with duplicate rejection', async () => {
    seedPeer('peer-dup');
    seedOutboxEntry('entry-dup', 'peer-dup', 'msg-already-there');

    // Mock the fetch to return a relay response with duplicate rejection
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        accepted: [],
        rejected: [{ messageId: 'msg-already-there', reason: 'duplicate' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const workerModule = await import('./federationWorker.js');
    const processOutboxTick = (workerModule as { processOutboxTick?: () => Promise<void> }).processOutboxTick;
    if (!processOutboxTick) {
      throw new Error('processOutboxTick must be exported for this test. If not yet exported, export it.');
    }
    await processOutboxTick();

    // Verify the outbox entry was deleted (terminal treatment)
    const remaining = testDb.select().from(schema.federationOutbox)
      .where(eq(schema.federationOutbox.id, 'entry-dup')).get();
    expect(remaining).toBeUndefined();
  });

  it('retains outbox entries for non-duplicate rejection reasons (e.g., processing_error)', async () => {
    seedPeer('peer-transient');
    seedOutboxEntry('entry-transient', 'peer-transient', 'msg-transient');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        accepted: [],
        rejected: [{ messageId: 'msg-transient', reason: 'processing_error' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const workerModule = await import('./federationWorker.js');
    const processOutboxTick = (workerModule as { processOutboxTick?: () => Promise<void> }).processOutboxTick;
    if (!processOutboxTick) {
      throw new Error('processOutboxTick must be exported for this test.');
    }
    await processOutboxTick();

    const remaining = testDb.select().from(schema.federationOutbox)
      .where(eq(schema.federationOutbox.id, 'entry-transient')).get();
    // The entry must be retained — a 200 OK with a transient rejection reason
    // does not delete the outbox entry. (Backoff is only applied on non-OK HTTP
    // responses; a 200 with a rejection means the peer processed the batch but
    // declined this particular message — the entry stays for the next tick.)
    expect(remaining).toBeDefined();
  });
});
