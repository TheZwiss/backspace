import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { FederationRelayEvent } from '@backspace/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const sentToUserCalls: Array<{ userId: string; payload: any }> = [];

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn((uid: string, p: any) => sentToUserCalls.push({ userId: uid, payload: p })),
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
  sentToUserCalls.length = 0;
  // Local user (youruser) and replicated stub (pbtest3) — they're friends.
  testDb.insert(schema.users).values([
    {
      id: 'local-youruser', username: 'youruser', passwordHash: 'x', status: 'online', isAdmin: 0,
      homeUserId: 'local-youruser', createdAt: Date.now(),
    },
    {
      id: 'stub-pbtest3', username: 'pbtest3@orbit.ddns.net', displayName: 'pbtest3',
      passwordHash: '!federation-replicated', status: 'offline', isAdmin: 0,
      homeInstance: 'orbit.ddns.net', homeUserId: 'home-pbtest3', createdAt: Date.now(),
    },
  ]).run();
  testDb.insert(schema.friends).values({
    userId: 'local-youruser', friendId: 'stub-pbtest3', createdAt: Date.now(),
  }).run();
});

describe('processPresenceUpdateEvent', () => {
  it('updates stub status and broadcasts presence_update to local friends', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'presence_update',
      contextType: 'profile',
      messageId: 'p1',
      encryptionVersion: 0,
      timestamp: Date.now(),
      presenceUpdate: {
        homeUserId: 'home-pbtest3',
        homeInstance: 'orbit.ddns.net',
        status: 'online',
        ts: Date.now(),
      },
    };
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processPresenceUpdateEvent(event, 'orbit.ddns.net', testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['p1']);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-pbtest3')).get();
    expect(row!.status).toBe('online');

    const broadcast = sentToUserCalls.find((c) => c.userId === 'local-youruser');
    expect(broadcast).toBeDefined();
    expect(broadcast!.payload.type).toBe('presence_update');
    expect(broadcast!.payload.userId).toBe('stub-pbtest3');
    expect(broadcast!.payload.status).toBe('online');
  });

  it('rejects on attribution mismatch', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'presence_update', contextType: 'profile', messageId: 'p2',
      encryptionVersion: 0, timestamp: Date.now(),
      presenceUpdate: {
        homeUserId: 'home-pbtest3', homeInstance: 'orbit.ddns.net',
        status: 'online', ts: Date.now(),
      },
    };
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processPresenceUpdateEvent(event, 'evil.example.com', testDb, [], rejected);
    expect(rejected).toEqual([{ messageId: 'p2', reason: 'attribution_mismatch' }]);
  });

  it('silently accepts when no replica exists locally', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'presence_update', contextType: 'profile', messageId: 'p3',
      encryptionVersion: 0, timestamp: Date.now(),
      presenceUpdate: {
        homeUserId: 'unknown-id', homeInstance: 'orbit.ddns.net',
        status: 'online', ts: Date.now(),
      },
    };
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processPresenceUpdateEvent(event, 'orbit.ddns.net', testDb, accepted, rejected);
    expect(accepted).toEqual(['p3']);
    expect(rejected).toEqual([]);
  });

  it('rejects invalid status values', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'presence_update', contextType: 'profile', messageId: 'p4',
      encryptionVersion: 0, timestamp: Date.now(),
      presenceUpdate: {
        homeUserId: 'home-pbtest3', homeInstance: 'orbit.ddns.net',
        status: 'invisible' as any, ts: Date.now(),
      },
    };
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processPresenceUpdateEvent(event, 'orbit.ddns.net', testDb, [], rejected);
    expect(rejected).toEqual([{ messageId: 'p4', reason: 'invalid_status' }]);
  });

  it('passes activities through to the WS broadcast when present', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'presence_update', contextType: 'profile', messageId: 'p5',
      encryptionVersion: 0, timestamp: Date.now(),
      presenceUpdate: {
        homeUserId: 'home-pbtest3', homeInstance: 'orbit.ddns.net',
        status: 'online', activities: [{ type: 'playing', name: 'Test' }],
        ts: Date.now(),
      },
    };
    fed.processPresenceUpdateEvent(event, 'orbit.ddns.net', testDb, [], []);
    const broadcast = sentToUserCalls.find((c) => c.userId === 'local-youruser');
    expect(broadcast!.payload.activities).toEqual([{ type: 'playing', name: 'Test' }]);
  });
});
