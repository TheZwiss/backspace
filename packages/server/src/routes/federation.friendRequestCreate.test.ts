import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { FederationRelayEvent } from '@backspace/shared';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
const sendToUser = vi.fn();

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../ws/handler.js', () => ({
  connectionManager: { sendToUser, sendToAdmins: vi.fn(), sendToDmMembers: vi.fn(), getAllOnlineUserIds: () => [] },
}));
vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://home.test' };
});

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  sendToUser.mockReset();
});

describe('processRelayEvents — friend_request_create from sender home (S2S friend-add wire format)', () => {
  it('accepts the event, creates the local request, hydrates the sender stub, broadcasts to recipient', async () => {
    // Seed local recipient
    testDb.insert(schema.users).values({
      id: 'alice-id',
      username: 'alice',
      passwordHash: 'x',
      status: 'online',
      isAdmin: 0,
      createdAt: Date.now(),
    } as typeof schema.users.$inferInsert).run();

    // Seed active peer for the source instance
    testDb.insert(schema.federationPeers).values({
      id: 'peer-orbit',
      origin: 'https://orbit.test',
      hmacSecret: 'a'.repeat(64),
      status: 'active',
      nonceSupported: 1,
      createdAt: Date.now(),
      consecutiveFailures: 0,
      consecutiveAuthFailures: 0,
    } as typeof schema.federationPeers.$inferInsert).run();

    const event: FederationRelayEvent = {
      eventType: 'friend_request_create',
      contextType: 'friend',
      messageId: 'friend_req:alice-id:remote-bob:12345',
      encryptionVersion: 0,
      timestamp: 12345,
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob', displayName: 'Bob', avatar: null, avatarColor: 'mint', banner: null, bio: null },
        toProfile: { username: 'alice', displayName: 'Alice', avatar: null, avatarColor: 'rose', banner: null, bio: null },
        status: 'pending',
        createdAt: 12345,
      },
    };

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    // Wire-format invariant: accepted, no rejection.
    expect(result.accepted).toEqual(['friend_req:alice-id:remote-bob:12345']);
    expect(result.rejected).toEqual([]);

    // Stub for sender was auto-created. Note: resolveOrCreateReplicatedUser
    // stores homeInstance as bare host (extractDomain), not full URL.
    const bobStub = testDb.select().from(schema.users)
      .where(eq(schema.users.homeUserId, 'remote-bob')).get();
    expect(bobStub).toBeDefined();
    expect(bobStub!.homeInstance).toBe('orbit.test');

    // Friend request row inserted: from=stub, to=alice.
    const reqs = testDb.select().from(schema.friendRequests).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.toId).toBe('alice-id');
    expect(reqs[0]!.fromId).toBe(bobStub!.id);
    expect(reqs[0]!.status).toBe('pending');

    // WS broadcast to alice with friend_request_received and the bob profile.
    expect(sendToUser).toHaveBeenCalledOnce();
    const [userId, evt] = sendToUser.mock.calls[0]!;
    expect(userId).toBe('alice-id');
    expect(evt.type).toBe('friend_request_received');
    expect(evt.request.fromId).toBe(bobStub!.id);
    expect(evt.request.toId).toBe('alice-id');
    expect(evt.request.user?.displayName).toBe('Bob');
  });
});
