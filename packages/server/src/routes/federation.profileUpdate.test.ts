import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { FederationRelayEvent } from '@backspace/shared';
import { connectionManager } from '../ws/handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    evictFederatedCallsForHost: vi.fn(),
    federatedCalls: new Map(),
    isUserOnline: vi.fn(),
    lateBindFederatedCall: vi.fn(),
  },
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  // Stub seeded with displayName='pbtest3' (set previously by hydrateReplicatedUserProfile)
  testDb.insert(schema.users).values({
    id: 'stub-1',
    username: 'pbtest3@orbit.ddns.net',
    displayName: 'pbtest3',
    passwordHash: '!federation-replicated',
    status: 'offline',
    isAdmin: 0,
    homeInstance: 'orbit.ddns.net',
    homeUserId: 'home-1',
    profileUpdatedAt: 1000,
    createdAt: Date.now(),
  }).run();
});

describe('processProfileUpdateEvent — displayName fallback', () => {
  it('falls back to username when home displayName is null', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'profile_update',
      contextType: 'profile',
      messageId: 'm1',
      encryptionVersion: 0,
      timestamp: Date.now(),
      profileUpdate: {
        homeUserId: 'home-1',
        homeInstance: 'orbit.ddns.net',
        profileUpdatedAt: 2000,
        username: 'pbtest3',
        displayName: null,
        avatar: null,
        banner: null,
        accentColor: null,
        avatarColor: null,
        bio: null,
      },
    };
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processProfileUpdateEvent(event, 'orbit.ddns.net', testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['m1']);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-1')).get();
    expect(row!.displayName).toBe('pbtest3'); // fell back to username, not clobbered to null
  });

  it('uses home displayName when provided (not the fallback)', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'profile_update',
      contextType: 'profile',
      messageId: 'm2',
      encryptionVersion: 0,
      timestamp: Date.now(),
      profileUpdate: {
        homeUserId: 'home-1',
        homeInstance: 'orbit.ddns.net',
        profileUpdatedAt: 3000,
        username: 'pbtest3',
        displayName: 'Peter B.',
        avatar: null,
        banner: null,
        accentColor: null,
        avatarColor: null,
        bio: null,
      },
    };
    await fed.processProfileUpdateEvent(event, 'orbit.ddns.net', testDb, [], []);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-1')).get();
    expect(row!.displayName).toBe('Peter B.');
  });
});

/**
 * Profile fields of a remote user change only through the home's versioned
 * `profile_update`. A snapshot relayed with a DM or friend event may be built
 * by a third instance from its own replica, and it carries no version, so
 * hydration only fills a field that is still empty and never flips one.
 */
describe('relayed profile snapshots never overwrite a stored field', () => {
  function userUpdatedCount(): number {
    return vi.mocked(connectionManager.sendToUser).mock.calls
      .filter(([, event]) => (event as { type: string }).type === 'user_updated')
      .length;
  }

  function stub(): typeof schema.users.$inferSelect {
    return testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-1')).get()!;
  }

  beforeEach(() => {
    vi.mocked(connectionManager.sendToUser).mockClear();
    testDb.insert(schema.users).values({ id: 'local-anna', username: 'anna', passwordHash: 'x', createdAt: Date.now() }).run();
    testDb.insert(schema.friends).values({ userId: 'local-anna', friendId: 'stub-1', createdAt: Date.now() }).run();
  });

  it('a stale snapshot from a third instance does not flip avatarColor set by the home, and announces nothing', async () => {
    const fed = await import('./federation.js');
    await fed.processProfileUpdateEvent({
      eventType: 'profile_update',
      contextType: 'profile',
      messageId: 'pu-mint',
      encryptionVersion: 0,
      timestamp: Date.now(),
      profileUpdate: {
        homeUserId: 'home-1',
        homeInstance: 'orbit.ddns.net',
        profileUpdatedAt: 5000,
        username: 'pbtest3',
        displayName: 'pbtest3',
        avatar: null,
        banner: null,
        accentColor: null,
        avatarColor: 'mint',
        bio: null,
      },
    }, 'orbit.ddns.net', testDb, [], []);
    expect(stub().avatarColor).toBe('mint');
    vi.mocked(connectionManager.sendToUser).mockClear();

    // Messages alternate between the home (current colour) and a third
    // instance whose replica still holds the old one.
    for (const colour of ['rose', 'mint', 'rose', 'mint']) {
      await fed.hydrateReplicatedUserProfile(stub(), { username: 'pbtest3@orbit.ddns.net', avatarColor: colour }, testDb);
      expect(stub().avatarColor).toBe('mint');
    }
    expect(userUpdatedCount()).toBe(0);
  });

  it('an empty avatarColor is filled once from a snapshot and announced once', async () => {
    const fed = await import('./federation.js');
    expect(stub().avatarColor).toBeNull();
    await fed.hydrateReplicatedUserProfile(stub(), { avatarColor: 'rose' }, testDb);
    expect(stub().avatarColor).toBe('rose');
    expect(userUpdatedCount()).toBe(1);

    await fed.hydrateReplicatedUserProfile(stub(), { avatarColor: 'mint' }, testDb);
    await fed.hydrateReplicatedUserProfile(stub(), { avatarColor: 'rose' }, testDb);
    expect(stub().avatarColor).toBe('rose');
    expect(userUpdatedCount()).toBe(1);
  });

  it('the home\'s newer profile_update still replaces avatarColor and announces it', async () => {
    const fed = await import('./federation.js');
    await fed.hydrateReplicatedUserProfile(stub(), { avatarColor: 'rose' }, testDb);
    vi.mocked(connectionManager.sendToUser).mockClear();
    await fed.processProfileUpdateEvent({
      eventType: 'profile_update',
      contextType: 'profile',
      messageId: 'pu-sky',
      encryptionVersion: 0,
      timestamp: Date.now(),
      profileUpdate: {
        homeUserId: 'home-1',
        homeInstance: 'orbit.ddns.net',
        profileUpdatedAt: 6000,
        username: 'pbtest3',
        displayName: 'pbtest3',
        avatar: null,
        banner: null,
        accentColor: null,
        avatarColor: 'sky',
        bio: null,
      },
    }, 'orbit.ddns.net', testDb, [], []);
    expect(stub().avatarColor).toBe('sky');
    expect(userUpdatedCount()).toBeGreaterThan(0);
  });
});
