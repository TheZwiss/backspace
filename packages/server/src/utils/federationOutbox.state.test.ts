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

// Mutable reference updated in beforeEach — the factory closes over this.
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

// Mock federation-auth helpers to avoid env-var dependency
vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://local.example',
  buildFederationHeaders: () => ({}),
  generateHmacSecret: () => 'test-secret',
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

function seedSettings(): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    federationRelayEnabled: 1,
    federationRelayTtlDays: 30,
    updatedAt: Date.now(),
  }).run();
}

function seedPeer(id: string, origin: string, status: string): void {
  testDb.insert(schema.federationPeers).values({
    id, origin, hmacSecret: 'secret',
    status, lastSyncedAt: 0, createdAt: Date.now(),
  }).run();
}

function countOutbox(peerId: string): number {
  return testDb.select().from(schema.federationOutbox)
    .where(eq(schema.federationOutbox.peerId, peerId))
    .all().length;
}

// Import once at module level — vi.mock is hoisted and the factory returns the
// live testDb reference, so re-using the cached import is correct.
const { queueOutboxEvent } = await import('./federationOutbox.js');

describe('queueOutboxEvent — non-deliverable statuses', () => {
  beforeEach(() => {
    const sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedSettings();
    vi.restoreAllMocks();
  });

  it.each([
    ['awaiting_approval'],
    ['needs_attention'],
    ['rejected'],
    ['revoked'],
  ])('drops the event and logs a reason for %s peers (no outbox row, no throw)', (status) => {
    seedPeer('peer-drop', 'https://drop.example', status);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    queueOutboxEvent('entity-1', 'ctx-1', 'create', '{}', ['https://drop.example'], 'dm');

    expect(countOutbox('peer-drop')).toBe(0);
    expect(debugSpy).toHaveBeenCalled();
    expect(debugSpy.mock.calls[0]![0] as string).toContain(status);
  });
});
