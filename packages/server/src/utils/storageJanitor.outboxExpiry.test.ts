import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

/**
 * The relay TTL sweep expires a queue, not a row: an event queued behind one
 * that expired undelivered changes something the peer may never have got
 * (an edit behind a create, a cancel behind a friend request), so it goes
 * with it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../config.js', () => ({
  config: {
    domain: 'local.example',
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'x'.repeat(32),
    maxUploadSize: 100 * 1024 * 1024,
    registrationOpen: true,
    federation: { allowPrivatePeers: false },
    uploadDir: '/tmp/backspace-test-uploads',
  },
}));

const NOW = 1_800_000_000_000;
const EXPIRED = NOW - 1;
const ALIVE = NOW + 1_000_000;

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedPeer(id: string): void {
  testDb.insert(schema.federationPeers).values({
    id, origin: `https://${id}.example`, hmacSecret: 'secret', status: 'active', createdAt: NOW,
  }).run();
}

function seedRow(id: string, opts: { peerId?: string; queueKey: string | null; createdAt: number; expiresAt: number; eventType?: string }): void {
  testDb.insert(schema.federationOutbox).values({
    id,
    peerId: opts.peerId ?? 'p1',
    contextId: 'ctx',
    entityId: `entity-${id}`,
    queueKey: opts.queueKey,
    contextType: 'dm',
    eventType: opts.eventType ?? 'create',
    payload: '{}',
    encryptionVersion: 0,
    attempts: 0,
    nextRetryAt: NOW,
    expiresAt: opts.expiresAt,
    createdAt: opts.createdAt,
  }).run();
}

function outboxIds(): string[] {
  return testDb.select({ id: schema.federationOutbox.id }).from(schema.federationOutbox)
    .all().map(r => r.id).sort();
}

describe('cleanupFederationOutbox: expiry by queue', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedPeer('p1');
    seedPeer('p2');
  });

  afterEach(() => {
    sqlite.close();
  });

  it('expires the rows queued behind an expired head with it', async () => {
    seedRow('head', { queueKey: 'message:m1', createdAt: 1, expiresAt: EXPIRED });
    seedRow('behind', { queueKey: 'message:m1', createdAt: 2, expiresAt: ALIVE });
    const { cleanupFederationOutbox } = await import('./storageJanitor.js');

    expect(cleanupFederationOutbox(NOW)).toBe(2);
    expect(outboxIds()).toEqual([]);
  });

  it('keeps what is queued ahead of an expired row, and removes what is behind it', async () => {
    // A row can expire before the one ahead of it when the relay TTL was
    // shortened between the two.
    seedRow('ahead', { queueKey: 'friendship:a:b', createdAt: 1, expiresAt: ALIVE });
    seedRow('expired', { queueKey: 'friendship:a:b', createdAt: 2, expiresAt: EXPIRED });
    seedRow('behind', { queueKey: 'friendship:a:b', createdAt: 3, expiresAt: ALIVE });
    const { cleanupFederationOutbox } = await import('./storageJanitor.js');

    expect(cleanupFederationOutbox(NOW)).toBe(2);
    expect(outboxIds()).toEqual(['ahead']);
  });

  it('leaves other queues alone, including the same key for another peer', async () => {
    seedRow('head', { queueKey: 'message:m1', createdAt: 1, expiresAt: EXPIRED });
    seedRow('other-key', { queueKey: 'message:m2', createdAt: 2, expiresAt: ALIVE });
    seedRow('other-peer', { peerId: 'p2', queueKey: 'message:m1', createdAt: 2, expiresAt: ALIVE });
    const { cleanupFederationOutbox } = await import('./storageJanitor.js');

    expect(cleanupFederationOutbox(NOW)).toBe(1);
    expect(outboxIds()).toEqual(['other-key', 'other-peer']);
  });

  it('keeps a state event behind an expired row: it carries the whole state on its own', async () => {
    // Two rows in a state queue exist only from before queue keys (a legacy
    // close and reopen, now one queue); a new state event replaces the queue.
    seedRow('close', { queueKey: 'dm_open:f:h:u', createdAt: 1, expiresAt: EXPIRED, eventType: 'dm_close' });
    seedRow('reopen', { queueKey: 'dm_open:f:h:u', createdAt: 2, expiresAt: ALIVE, eventType: 'dm_reopen' });
    const { cleanupFederationOutbox } = await import('./storageJanitor.js');

    expect(cleanupFederationOutbox(NOW)).toBe(1);
    expect(outboxIds()).toEqual(['reopen']);
  });

  it('expires a row without a queue key on its own', async () => {
    seedRow('legacy', { queueKey: null, createdAt: 1, expiresAt: EXPIRED });
    seedRow('legacy-alive', { queueKey: null, createdAt: 2, expiresAt: ALIVE });
    const { cleanupFederationOutbox } = await import('./storageJanitor.js');

    expect(cleanupFederationOutbox(NOW)).toBe(1);
    expect(outboxIds()).toEqual(['legacy-alive']);
  });
});
