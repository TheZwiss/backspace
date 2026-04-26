import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';

setWorkerId(2);

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
    jwtSecret: 'test-secret-12345678901234567890123456789012',
    maxUploadSize: 100 * 1024 * 1024,
    registrationOpen: true,
    uploadDir: '/tmp/backspace-test-uploads',
  },
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

function seedUser(id: string, username: string): void {
  testDb.insert(schema.users).values({
    id,
    username,
    passwordHash: 'x',
    displayName: username,
    createdAt: Date.now(),
  }).run();
}

describe('cleanupExpiredApprovalRequests', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedUser('alice', 'alice');
    seedUser('bob', 'bob');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  // Janitor expiry test A: outbound row with subscribers + past expiresAt →
  // janitor writes kind='expired' notifications to each subscriber, cascade-deletes parent.
  it('outbound expired row: fans out kind=expired notifications to each subscriber, then cascade-deletes parent', async () => {
    const past = Date.now() - 1_000;
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'req-out',
      origin: 'https://orbit.example',
      direction: 'outbound',
      instanceName: 'Orbit',
      hmacSecret: null,
      requestedAt: past - 1000,
      expiresAt: past,
      approvalToken: null,
    }).run();
    testDb.insert(schema.peerApprovalSubscribers).values({
      id: 'sub-alice',
      requestId: 'req-out',
      userId: 'alice',
      triggerReason: 'friend_add',
      triggerTarget: 'someone@orbit.example',
      createdAt: past - 1000,
    }).run();
    testDb.insert(schema.peerApprovalSubscribers).values({
      id: 'sub-bob',
      requestId: 'req-out',
      userId: 'bob',
      triggerReason: 'space_join',
      triggerTarget: 'invite-xyz',
      createdAt: past - 500,
    }).run();

    const { cleanupExpiredApprovalRequests } = await import('./storageJanitor.js');
    const before = Date.now();
    const cleaned = cleanupExpiredApprovalRequests();
    const after = Date.now();

    expect(cleaned).toBe(1);

    // Parent deleted.
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-out')).get()).toBeUndefined();

    // Subscribers cascade-deleted.
    expect(testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.requestId, 'req-out')).all()).toHaveLength(0);

    // Each subscriber received a kind='expired' notification preserving their
    // trigger_reason / trigger_target.
    const allNotifs = testDb.select().from(schema.peerApprovalNotifications).all();
    expect(allNotifs).toHaveLength(2);

    const aliceNotif = allNotifs.find(n => n.userId === 'alice');
    const bobNotif = allNotifs.find(n => n.userId === 'bob');

    expect(aliceNotif).toBeDefined();
    expect(aliceNotif!.kind).toBe('expired');
    expect(aliceNotif!.peerOrigin).toBe('https://orbit.example');
    expect(aliceNotif!.triggerReason).toBe('friend_add');
    expect(aliceNotif!.triggerTarget).toBe('someone@orbit.example');
    expect(aliceNotif!.readAt).toBeNull();
    expect(aliceNotif!.createdAt).toBeGreaterThanOrEqual(before);
    expect(aliceNotif!.createdAt).toBeLessThanOrEqual(after);

    expect(bobNotif).toBeDefined();
    expect(bobNotif!.kind).toBe('expired');
    expect(bobNotif!.peerOrigin).toBe('https://orbit.example');
    expect(bobNotif!.triggerReason).toBe('space_join');
    expect(bobNotif!.triggerTarget).toBe('invite-xyz');
    expect(bobNotif!.readAt).toBeNull();
  });

  // Janitor expiry test B: inbound row with past expiresAt → janitor deletes
  // it without writing any notifications.
  it('inbound expired row: deletes outright with NO notifications written', async () => {
    const past = Date.now() - 1_000;
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'req-in',
      origin: 'https://orbit.example',
      direction: 'inbound',
      instanceName: 'Orbit',
      hmacSecret: 'shared-secret',
      requestedAt: past - 1000,
      expiresAt: past,
      approvalToken: null,
    }).run();

    const { cleanupExpiredApprovalRequests } = await import('./storageJanitor.js');
    const cleaned = cleanupExpiredApprovalRequests();

    expect(cleaned).toBe(1);

    // Parent deleted.
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-in')).get()).toBeUndefined();

    // No notifications written for inbound.
    expect(testDb.select().from(schema.peerApprovalNotifications).all()).toHaveLength(0);
  });

  // Mixed: not-yet-expired rows are not touched, regardless of direction.
  it('does not touch rows whose expiresAt is in the future', async () => {
    const future = Date.now() + 60_000;
    testDb.insert(schema.peerApprovalRequests).values({
      id: 'req-future-out',
      origin: 'https://a.example',
      direction: 'outbound',
      instanceName: null,
      hmacSecret: null,
      requestedAt: Date.now(),
      expiresAt: future,
      approvalToken: null,
    }).run();
    testDb.insert(schema.peerApprovalSubscribers).values({
      id: 'sub-future',
      requestId: 'req-future-out',
      userId: 'alice',
      triggerReason: 'friend_add',
      triggerTarget: 'a@a.example',
      createdAt: Date.now(),
    }).run();

    const { cleanupExpiredApprovalRequests } = await import('./storageJanitor.js');
    const cleaned = cleanupExpiredApprovalRequests();

    expect(cleaned).toBe(0);

    // Row still present.
    expect(testDb.select().from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, 'req-future-out')).get()).toBeDefined();
    expect(testDb.select().from(schema.peerApprovalSubscribers)
      .where(eq(schema.peerApprovalSubscribers.id, 'sub-future')).get()).toBeDefined();
    expect(testDb.select().from(schema.peerApprovalNotifications).all()).toHaveLength(0);
  });
});

describe('cleanupReadPeeringNotifications', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedUser('alice', 'alice');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  // Cleanup test: read notifications older than 30 days are deleted; unread
  // and recent-read notifications are NOT deleted.
  it('deletes only read-AND-old notifications; unread and recent-read survive', async () => {
    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const cutoffMargin = 60_000;

    // (a) Read & older than 30 days → DELETE
    testDb.insert(schema.peerApprovalNotifications).values({
      id: 'old-read',
      userId: 'alice',
      kind: 'approved',
      peerOrigin: 'https://a.example',
      triggerReason: 'friend_add',
      triggerTarget: 'a@a.example',
      createdAt: now - THIRTY_DAYS - 5 * 60_000,
      readAt: now - THIRTY_DAYS - cutoffMargin,
    }).run();

    // (b) Read & recent (< 30 days old) → KEEP
    testDb.insert(schema.peerApprovalNotifications).values({
      id: 'recent-read',
      userId: 'alice',
      kind: 'denied',
      peerOrigin: 'https://b.example',
      triggerReason: 'space_join',
      triggerTarget: 'invite-y',
      createdAt: now - 5 * 60_000,
      readAt: now - 60_000,
    }).run();

    // (c) Unread (regardless of age) → KEEP
    testDb.insert(schema.peerApprovalNotifications).values({
      id: 'old-unread',
      userId: 'alice',
      kind: 'expired',
      peerOrigin: 'https://c.example',
      triggerReason: 'direct_message',
      triggerTarget: 'c@c.example',
      createdAt: now - THIRTY_DAYS - 10 * 60_000,
      readAt: null,
    }).run();
    testDb.insert(schema.peerApprovalNotifications).values({
      id: 'fresh-unread',
      userId: 'alice',
      kind: 'approved',
      peerOrigin: 'https://d.example',
      triggerReason: 'friend_add',
      triggerTarget: 'd@d.example',
      createdAt: now - 60_000,
      readAt: null,
    }).run();

    const { cleanupReadPeeringNotifications } = await import('./storageJanitor.js');
    const deleted = cleanupReadPeeringNotifications();

    expect(deleted).toBe(1);

    expect(testDb.select().from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'old-read')).get()).toBeUndefined();
    expect(testDb.select().from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'recent-read')).get()).toBeDefined();
    expect(testDb.select().from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'old-unread')).get()).toBeDefined();
    expect(testDb.select().from(schema.peerApprovalNotifications)
      .where(eq(schema.peerApprovalNotifications.id, 'fresh-unread')).get()).toBeDefined();
  });
});
