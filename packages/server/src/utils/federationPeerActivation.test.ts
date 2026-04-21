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

function seedPeer(id: string, status: string, lastSyncedAt = 0): void {
  testDb.insert(schema.federationPeers).values({
    id, origin: `https://${id}.example`, hmacSecret: 'secret',
    status, lastSyncedAt, createdAt: Date.now(),
  }).run();
}

function seedOutboxEntry(id: string, peerId: string, nextRetryAt: number, attempts: number): void {
  testDb.insert(schema.federationOutbox).values({
    id, peerId, contextId: 'ch-1', entityId: `msg-${id}`,
    contextType: 'dm', eventType: 'create', payload: '{}',
    encryptionVersion: 0, attempts, nextRetryAt,
    expiresAt: Date.now() + 30 * 86_400_000,
    createdAt: Date.now(),
  }).run();
}

describe('resetOutboxBackoff', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
  });

  it('resets nextRetryAt=now and attempts=0 for all peer entries — including past-due ones', async () => {
    const { resetOutboxBackoff } = await import('./federationPeerActivation.js');
    seedPeer('peer-a', 'active');
    seedPeer('peer-b', 'active');
    const now = Date.now();

    // Three entries for peer-a: past-due (already eligible), near-future, far-future
    seedOutboxEntry('entry-1', 'peer-a', now - 1000, 5);
    seedOutboxEntry('entry-2', 'peer-a', now + 60_000, 3);
    seedOutboxEntry('entry-3', 'peer-a', now + 86_400_000, 7);
    // Entry for unrelated peer-b (must NOT be touched)
    seedOutboxEntry('entry-4', 'peer-b', now + 86_400_000, 9);

    resetOutboxBackoff('peer-a');

    const a1 = testDb.select().from(schema.federationOutbox).where(eq(schema.federationOutbox.id, 'entry-1')).get();
    const a2 = testDb.select().from(schema.federationOutbox).where(eq(schema.federationOutbox.id, 'entry-2')).get();
    const a3 = testDb.select().from(schema.federationOutbox).where(eq(schema.federationOutbox.id, 'entry-3')).get();
    const b4 = testDb.select().from(schema.federationOutbox).where(eq(schema.federationOutbox.id, 'entry-4')).get();

    // All peer-a entries reset — including the past-due one (correctness: attempts=0 on those too)
    expect(a1?.attempts).toBe(0);
    expect(a2?.attempts).toBe(0);
    expect(a3?.attempts).toBe(0);
    expect(a1?.nextRetryAt).toBeGreaterThanOrEqual(now);
    expect(a2?.nextRetryAt).toBeLessThanOrEqual(Date.now());
    expect(a3?.nextRetryAt).toBeLessThanOrEqual(Date.now());
    // peer-b untouched
    expect(b4?.attempts).toBe(9);
    expect(b4?.nextRetryAt).toBe(now + 86_400_000);
  });

  it('is a no-op when the peer has no outbox entries', async () => {
    const { resetOutboxBackoff } = await import('./federationPeerActivation.js');
    seedPeer('peer-empty', 'active');
    expect(() => resetOutboxBackoff('peer-empty')).not.toThrow();
  });
});
