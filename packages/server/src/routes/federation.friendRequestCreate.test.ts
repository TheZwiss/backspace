import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { FederationRelayEvent, FederationFriendshipPayload } from '@backspace/shared';

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

function seedLocalUser(id: string, username: string): void {
  testDb.insert(schema.users).values({
    id,
    username,
    passwordHash: 'x',
    status: 'online',
    isAdmin: 0,
    createdAt: Date.now(),
  } as typeof schema.users.$inferInsert).run();
}

function seedReplicatedUser(opts: {
  id: string;
  username: string;
  homeUserId: string;
  homeInstance: string;
  isDeleted?: 0 | 1;
}): void {
  testDb.insert(schema.users).values({
    id: opts.id,
    username: opts.username,
    passwordHash: '!federation-replicated',
    status: 'offline',
    isAdmin: 0,
    homeInstance: opts.homeInstance,
    homeUserId: opts.homeUserId,
    isDeleted: opts.isDeleted ?? 0,
    createdAt: Date.now(),
  } as typeof schema.users.$inferInsert).run();
}

function makeEvent(opts: {
  messageId?: string;
  friendship?: Partial<FederationFriendshipPayload> & { from: FederationFriendshipPayload['from']; to: FederationFriendshipPayload['to'] };
  omitFriendship?: boolean;
}): FederationRelayEvent {
  const base: FederationRelayEvent = {
    eventType: 'friend_request_create',
    contextType: 'friend',
    messageId: opts.messageId ?? 'msg-' + Math.random().toString(36).slice(2),
    encryptionVersion: 0,
    timestamp: 12345,
  };
  if (opts.omitFriendship) return base;
  base.friendship = {
    createdAt: 12345,
    status: 'pending',
    ...opts.friendship,
  } as FederationFriendshipPayload;
  return base;
}

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

describe('processFriendRequestCreateEvent — branch coverage', () => {
  it('rejects event with missing friendship payload', async () => {
    const event = makeEvent({ messageId: 'no-payload', omitFriendship: true });
    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ messageId: 'no-payload', reason: 'missing_friendship_payload' }]);
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('rejects event when sender attribution does not match peer origin', async () => {
    seedLocalUser('alice-id', 'alice');
    // Sender's homeInstance claims orbit.test, but peer signing the relay is impostor.test.
    const event = makeEvent({
      messageId: 'attrib-mismatch',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://impostor.test', 'https://impostor.test', testDb);

    expect(result.rejected).toEqual([{ messageId: 'attrib-mismatch', reason: 'attribution_mismatch' }]);
    expect(result.accepted).toEqual([]);
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
    expect(testDb.select().from(schema.users).where(eq(schema.users.homeUserId, 'remote-bob')).all()).toHaveLength(0);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('silently accepts when sender identity is tombstoned (deleted) on this instance', async () => {
    seedLocalUser('alice-id', 'alice');
    // Pre-existing tombstoned record for the sender — resolveOrCreateReplicatedUser refuses to resurrect.
    seedReplicatedUser({
      id: 'bob-tombstone',
      username: 'remote-bob@orbit.test',
      homeUserId: 'remote-bob',
      homeInstance: 'orbit.test',
      isDeleted: 1,
    });

    const event = makeEvent({
      messageId: 'tombstoned-sender',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual(['tombstoned-sender']);
    expect(result.rejected).toEqual([]);
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('rejects with recipient_not_found when the recipient is not a local user', async () => {
    // No alice seeded; the to.homeUserId points to nothing local.
    const event = makeEvent({
      messageId: 'no-recipient',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'unknown-recipient', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.rejected).toEqual([{ messageId: 'no-recipient', reason: 'recipient_not_found' }]);
    expect(result.accepted).toEqual([]);
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('rejects with recipient_not_found when the matched local user is soft-deleted', async () => {
    // resolveLocalUser filters isDeleted=1, so a deleted recipient is treated as not found.
    testDb.insert(schema.users).values({
      id: 'alice-deleted',
      username: 'alice',
      passwordHash: 'x',
      status: 'offline',
      isAdmin: 0,
      isDeleted: 1,
      createdAt: Date.now(),
    } as typeof schema.users.$inferInsert).run();

    const event = makeEvent({
      messageId: 'recipient-deleted',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-deleted', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.rejected).toEqual([{ messageId: 'recipient-deleted', reason: 'recipient_not_found' }]);
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
  });

  it('accepts idempotently when users are already friends (sender→recipient row)', async () => {
    seedLocalUser('alice-id', 'alice');
    seedReplicatedUser({
      id: 'bob-stub',
      username: 'remote-bob@orbit.test',
      homeUserId: 'remote-bob',
      homeInstance: 'orbit.test',
    });
    testDb.insert(schema.friends).values({
      userId: 'bob-stub',
      friendId: 'alice-id',
      createdAt: Date.now(),
    }).run();

    const event = makeEvent({
      messageId: 'already-friends-fwd',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual(['already-friends-fwd']);
    expect(result.rejected).toEqual([]);
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('accepts idempotently when users are already friends (recipient→sender row)', async () => {
    seedLocalUser('alice-id', 'alice');
    seedReplicatedUser({
      id: 'bob-stub',
      username: 'remote-bob@orbit.test',
      homeUserId: 'remote-bob',
      homeInstance: 'orbit.test',
    });
    // Friendship persisted in the reverse column order — handler must still detect it.
    testDb.insert(schema.friends).values({
      userId: 'alice-id',
      friendId: 'bob-stub',
      createdAt: Date.now(),
    }).run();

    const event = makeEvent({
      messageId: 'already-friends-rev',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual(['already-friends-rev']);
    expect(result.rejected).toEqual([]);
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('accepts idempotently when a same-direction pending request already exists (re-delivery)', async () => {
    seedLocalUser('alice-id', 'alice');
    seedReplicatedUser({
      id: 'bob-stub',
      username: 'remote-bob@orbit.test',
      homeUserId: 'remote-bob',
      homeInstance: 'orbit.test',
    });
    testDb.insert(schema.friendRequests).values({
      id: 'existing-req',
      fromId: 'bob-stub',
      toId: 'alice-id',
      status: 'pending',
      createdAt: 1000,
    }).run();

    const event = makeEvent({
      messageId: 'redelivery',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual(['redelivery']);
    expect(result.rejected).toEqual([]);
    const reqs = testDb.select().from(schema.friendRequests).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.id).toBe('existing-req');
    expect(reqs[0]!.createdAt).toBe(1000);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('accepts and creates the request when only a non-pending (declined) request exists from the same sender', async () => {
    // Idempotency check is gated on status='pending', so a prior declined request must NOT block a fresh one.
    seedLocalUser('alice-id', 'alice');
    seedReplicatedUser({
      id: 'bob-stub',
      username: 'remote-bob@orbit.test',
      homeUserId: 'remote-bob',
      homeInstance: 'orbit.test',
    });
    testDb.insert(schema.friendRequests).values({
      id: 'old-declined',
      fromId: 'bob-stub',
      toId: 'alice-id',
      status: 'declined',
      createdAt: 1000,
    }).run();

    const event = makeEvent({
      messageId: 'after-decline',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
        createdAt: 5000,
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual(['after-decline']);
    expect(result.rejected).toEqual([]);
    const pending = testDb.select().from(schema.friendRequests)
      .where(and(
        eq(schema.friendRequests.fromId, 'bob-stub'),
        eq(schema.friendRequests.toId, 'alice-id'),
        eq(schema.friendRequests.status, 'pending'),
      )).all();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.createdAt).toBe(5000);
    expect(sendToUser).toHaveBeenCalledOnce();
  });

  it('reuses a pre-existing replicated sender on the happy path (no new stub)', async () => {
    seedLocalUser('alice-id', 'alice');
    seedReplicatedUser({
      id: 'bob-stub',
      username: 'remote-bob@orbit.test',
      homeUserId: 'remote-bob',
      homeInstance: 'orbit.test',
    });

    const event = makeEvent({
      messageId: 'reuse-stub',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual(['reuse-stub']);
    const stubs = testDb.select().from(schema.users)
      .where(eq(schema.users.homeUserId, 'remote-bob')).all();
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.id).toBe('bob-stub');

    const reqs = testDb.select().from(schema.friendRequests).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.fromId).toBe('bob-stub');
    expect(reqs[0]!.toId).toBe('alice-id');
  });

  it('hydrates profile snapshot fields onto the sender stub on creation', async () => {
    seedLocalUser('alice-id', 'alice');

    const event = makeEvent({
      messageId: 'hydrate-profile',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: {
          username: 'bob',
          displayName: 'Bob the Builder',
          avatar: 'avatar-bob.png',
          avatarColor: 'mint',
          banner: 'banner-bob.png',
          bio: 'I build things.',
        },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual(['hydrate-profile']);
    const stub = testDb.select().from(schema.users)
      .where(eq(schema.users.homeUserId, 'remote-bob')).get();
    expect(stub).toBeDefined();
    expect(stub!.displayName).toBe('Bob the Builder');
    // Bare filenames must be resolved against the sender's home origin.
    expect(stub!.avatar).toBe('https://orbit.test/api/uploads/avatar-bob.png');
    expect(stub!.banner).toBe('https://orbit.test/api/uploads/banner-bob.png');
    expect(stub!.avatarColor).toBe('mint');
    expect(stub!.bio).toBe('I build things.');

    // The WS broadcast carries the hydrated profile.
    const [, evt] = sendToUser.mock.calls[0]!;
    expect(evt.request.user?.displayName).toBe('Bob the Builder');
  });

  it('uses event.friendship.createdAt for the friend_request row when provided', async () => {
    seedLocalUser('alice-id', 'alice');

    const event = makeEvent({
      messageId: 'explicit-created-at',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
        createdAt: 4242,
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    const req = testDb.select().from(schema.friendRequests).get();
    expect(req?.createdAt).toBe(4242);
    const [, evt] = sendToUser.mock.calls[0]!;
    expect(evt.request.createdAt).toBe(4242);
  });

  it('falls back to a fresh timestamp when friendship.createdAt is missing', async () => {
    seedLocalUser('alice-id', 'alice');
    const before = Date.now();

    const event = makeEvent({
      messageId: 'no-created-at',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
      },
    });
    // Strip the default we set in makeEvent so the handler exercises its fallback.
    delete (event.friendship as { createdAt?: number }).createdAt;

    const { processRelayEvents } = await import('./federation.js');
    await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    const req = testDb.select().from(schema.friendRequests).get();
    expect(req?.createdAt).toBeGreaterThanOrEqual(before);
    expect(req?.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('accepts idempotently when a reverse-direction pending request already exists (cross-fire race)', async () => {
    // Race scenario: alice@home and bob@orbit both click "add friend" near-simultaneously.
    // Each sender's local both-direction check passes (no rows yet anywhere). When events cross,
    // alice's outbound creates the bob-stub→alice row first; bob's inbound (this event) must
    // detect the existing alice→bob-stub row in the REVERSE direction and silent-accept.
    seedLocalUser('alice-id', 'alice');
    seedReplicatedUser({
      id: 'bob-stub',
      username: 'remote-bob@orbit.test',
      homeUserId: 'remote-bob',
      homeInstance: 'orbit.test',
    });
    // Pre-existing reverse-direction row: alice (local) → bob-stub. Equivalent to alice having
    // already sent her own outbound friend request to bob just before bob's event arrived.
    testDb.insert(schema.friendRequests).values({
      id: 'alice-outbound',
      fromId: 'alice-id',
      toId: 'bob-stub',
      status: 'pending',
      createdAt: 1000,
    }).run();

    const event = makeEvent({
      messageId: 'reverse-direction-collision',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    // Idempotent silent-accept: no new row, no broadcast, original alice-outbound preserved.
    expect(result.accepted).toEqual(['reverse-direction-collision']);
    expect(result.rejected).toEqual([]);
    const reqs = testDb.select().from(schema.friendRequests).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.id).toBe('alice-outbound');
    expect(reqs[0]!.fromId).toBe('alice-id');
    expect(reqs[0]!.toId).toBe('bob-stub');
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('does not block on a non-pending reverse-direction row (declined)', async () => {
    // The reverse-direction idempotency must still be gated on status='pending'.
    // A previously declined request from alice→bob-stub does NOT make this event idempotent.
    seedLocalUser('alice-id', 'alice');
    seedReplicatedUser({
      id: 'bob-stub',
      username: 'remote-bob@orbit.test',
      homeUserId: 'remote-bob',
      homeInstance: 'orbit.test',
    });
    testDb.insert(schema.friendRequests).values({
      id: 'old-reverse-declined',
      fromId: 'alice-id',
      toId: 'bob-stub',
      status: 'declined',
      createdAt: 1000,
    }).run();

    const event = makeEvent({
      messageId: 'fresh-after-reverse-decline',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
        createdAt: 5000,
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual(['fresh-after-reverse-decline']);
    expect(result.rejected).toEqual([]);
    const pending = testDb.select().from(schema.friendRequests)
      .where(eq(schema.friendRequests.status, 'pending')).all();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.fromId).toBe('bob-stub');
    expect(pending[0]!.toId).toBe('alice-id');
    expect(sendToUser).toHaveBeenCalledOnce();
  });

  it('rejects with self_target_invalid when from-identity equals to-identity (defense-in-depth)', async () => {
    // Malformed/malicious event where the from and to identities collapse. The sender's
    // local cannot_friend_self check should prevent this, but the receiver must not trust it.
    // Pre-resolution rejection: no stub created, no row inserted, no broadcast.
    const event = makeEvent({
      messageId: 'self-target-raw',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        fromProfile: { username: 'bob' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.rejected).toEqual([{ messageId: 'self-target-raw', reason: 'self_target_invalid' }]);
    expect(result.accepted).toEqual([]);
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
    // No side-effect stub creation for the malformed identity.
    expect(testDb.select().from(schema.users).where(eq(schema.users.homeUserId, 'remote-bob')).all()).toHaveLength(0);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('rejects self-target even when origin shapes differ (URL vs bare host, trailing slash)', async () => {
    // normalizeOriginForCompare must collapse "https://orbit.test", "orbit.test", and
    // "https://orbit.test/" to the same canonical form so the guard is not bypassable
    // by surface formatting of homeInstance.
    const event = makeEvent({
      messageId: 'self-target-normalized',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'remote-bob', homeInstance: 'orbit.test/' },
        fromProfile: { username: 'bob' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.rejected).toEqual([{ messageId: 'self-target-normalized', reason: 'self_target_invalid' }]);
    expect(result.accepted).toEqual([]);
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('does not falsely flag self-target when only homeUserId matches across different instances', async () => {
    // Two different users on different instances who happen to share a homeUserId string
    // must NOT be treated as self-target. This protects against a too-aggressive guard.
    seedLocalUser('shared-id', 'alice');

    const event = makeEvent({
      messageId: 'shared-id-cross-instance',
      friendship: {
        from: { homeUserId: 'shared-id', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'shared-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual(['shared-id-cross-instance']);
    expect(result.rejected).toEqual([]);
    const reqs = testDb.select().from(schema.friendRequests).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.toId).toBe('shared-id');
    expect(sendToUser).toHaveBeenCalledOnce();
  });

  it('isolates per-event success/failure within a batch (mixed accepted/rejected)', async () => {
    seedLocalUser('alice-id', 'alice');

    const okEvent = makeEvent({
      messageId: 'batch-ok',
      friendship: {
        from: { homeUserId: 'remote-bob', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'alice-id', homeInstance: 'https://home.test' },
        fromProfile: { username: 'bob' },
      },
    });
    const badEvent = makeEvent({
      messageId: 'batch-bad',
      friendship: {
        from: { homeUserId: 'remote-eve', homeInstance: 'https://orbit.test' },
        to: { homeUserId: 'ghost', homeInstance: 'https://home.test' },
        fromProfile: { username: 'eve' },
      },
    });

    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([okEvent, badEvent], 'https://orbit.test', 'https://orbit.test', testDb);

    expect(result.accepted).toEqual(['batch-ok']);
    expect(result.rejected).toEqual([{ messageId: 'batch-bad', reason: 'recipient_not_found' }]);
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(1);
  });
});
