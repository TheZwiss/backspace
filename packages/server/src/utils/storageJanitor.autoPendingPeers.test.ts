import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const OLD = NOW - 2 * HOUR;

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

function seedPeer(
  id: string,
  opts: {
    status?: string;
    initiatedBy?: 'admin' | 'auto' | 'remote';
    createdAt?: number;
  } = {},
): void {
  testDb.insert(schema.federationPeers).values({
    id,
    origin: `https://${id}.example`,
    hmacSecret: 'secret',
    status: opts.status ?? 'pending',
    initiatedBy: opts.initiatedBy ?? 'auto',
    createdAt: opts.createdAt ?? OLD,
  }).run();
}

function seedEntry(
  id: string,
  peerId: string,
  eventType: string,
  contextType: string,
): void {
  testDb.insert(schema.federationOutbox).values({
    id,
    peerId,
    contextId: 'ctx-1',
    entityId: `entity-${id}`,
    contextType,
    eventType,
    payload: '{}',
    encryptionVersion: 0,
    attempts: 0,
    nextRetryAt: NOW,
    expiresAt: NOW + 30 * 24 * HOUR,
    createdAt: NOW,
  }).run();
}

function peerIds(): string[] {
  return testDb.select({ id: schema.federationPeers.id }).from(schema.federationPeers)
    .all().map(r => r.id).sort();
}

function outboxIds(): string[] {
  return testDb.select({ id: schema.federationOutbox.id }).from(schema.federationOutbox)
    .all().map(r => r.id).sort();
}

const nothingInFlight = (): boolean => false;

describe('cleanupUnusedAutoPendingPeers', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('removes an auto pending row past the grace period with nothing queued', async () => {
    seedPeer('empty');
    const { cleanupUnusedAutoPendingPeers } = await import('./storageJanitor.js');

    expect(cleanupUnusedAutoPendingPeers(nothingInFlight, NOW)).toBe(1);
    expect(peerIds()).toEqual([]);
  });

  it('keeps a row that still carries any entry, a presence change included', async () => {
    // Untargeted broadcasts no longer reach pending peers (#321), so whatever
    // is queued on a pending row was addressed to that origin and waits on
    // its handshake.
    seedPeer('dm');
    seedEntry('d1', 'dm', 'create', 'dm');
    seedPeer('friend');
    seedEntry('f1', 'friend', 'friend_request_create', 'friend');
    seedPeer('profile');
    seedEntry('pr1', 'profile', 'profile_update', 'profile');
    seedPeer('presence');
    seedEntry('ps1', 'presence', 'presence_update', 'profile');
    const { cleanupUnusedAutoPendingPeers } = await import('./storageJanitor.js');

    expect(cleanupUnusedAutoPendingPeers(nothingInFlight, NOW)).toBe(0);
    expect(peerIds()).toEqual(['dm', 'friend', 'presence', 'profile']);
    expect(outboxIds()).toEqual(['d1', 'f1', 'pr1', 'ps1']);
  });

  it('keeps an auto pending row younger than the grace period', async () => {
    const { cleanupUnusedAutoPendingPeers, AUTO_PENDING_PEER_GRACE_MS } = await import('./storageJanitor.js');
    seedPeer('young', { createdAt: NOW - AUTO_PENDING_PEER_GRACE_MS + 1 });
    seedPeer('just-old', { createdAt: NOW - AUTO_PENDING_PEER_GRACE_MS - 1 });

    expect(cleanupUnusedAutoPendingPeers(nothingInFlight, NOW)).toBe(1);
    expect(peerIds()).toEqual(['young']);
  });

  it('keeps rows the admin or the remote created, and auto rows that left pending', async () => {
    seedPeer('admin-row', { initiatedBy: 'admin' });
    seedPeer('remote-row', { initiatedBy: 'remote' });
    seedPeer('auto-active', { status: 'active' });
    seedPeer('auto-awaiting', { status: 'awaiting_approval' });
    seedPeer('auto-rejected', { status: 'rejected' });
    const { cleanupUnusedAutoPendingPeers } = await import('./storageJanitor.js');

    expect(cleanupUnusedAutoPendingPeers(nothingInFlight, NOW)).toBe(0);
    expect(peerIds()).toEqual(['admin-row', 'auto-active', 'auto-awaiting', 'auto-rejected', 'remote-row']);
  });

  it('keeps a row whose origin has a handshake in flight', async () => {
    seedPeer('handshaking');
    seedPeer('idle');
    const { cleanupUnusedAutoPendingPeers } = await import('./storageJanitor.js');

    const inFlight = (origin: string): boolean => origin === 'https://handshaking.example';
    expect(cleanupUnusedAutoPendingPeers(inFlight, NOW)).toBe(1);
    expect(peerIds()).toEqual(['handshaking']);
  });
});
