import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { generateSnowflake, setWorkerId } from './snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

// Disable the relay so syncPeerMutationLog is a no-op (no fetches).
vi.mock('./federationOutbox.js', () => ({
  isFederationRelayEnabled: () => false,
}));

vi.mock('./federationAuth.js', () => ({
  getOurOrigin: () => 'https://local.example',
  buildFederationHeaders: (_body: string, _secret: string, _origin: string) => ({
    'Content-Type': 'application/json',
    'X-Federation-Origin': _origin,
  }),
  generateHmacSecret: () => 'mock-hmac-secret',
}));

vi.mock('../routes/federation.js', () => ({
  processRelayEvents: vi.fn().mockResolvedValue({ accepted: [], rejected: [], undeliverable: [] }),
  validateOrigin: (raw: string) => {
    try {
      const url = new URL(raw);
      return url.origin;
    } catch {
      return null;
    }
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    sendToUser: vi.fn(),
    getAllOnlineUserIds: () => [],
    sendToDmMembers: vi.fn(),
    evictFederatedCallsForHost: vi.fn().mockReturnValue(0),
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
    createdAt: Date.now(),
  }).run();
}

function seedActivePeer(id: string, origin: string): void {
  testDb.insert(schema.federationPeers).values({
    id,
    origin,
    hmacSecret: 'secret',
    status: 'active',
    lastSyncedAt: Date.now(),  // non-zero so startupBootstrapSync wouldn't pick it up
    createdAt: Date.now(),
  }).run();
}

describe('onPeerActivated — outbound subscriber fanout', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  // ─── Test 10 ────────────────────────────────────────────────────────────
  // onPeerActivated with outbound queue + 2 subscribers → fans out approved
  // notifications to each subscriber, deletes parent (cascade clears subs),
  // and sends peering_notification_received WS to each subscriber.
  it('fans out approved notifications to all subscribers and deletes parent', async () => {
    seedUser('user1', 'alice');
    seedUser('user2', 'bob');
    seedActivePeer('peer-active', 'https://orbit.example');

    const parentId = generateSnowflake();
    const now = Date.now();
    testDb.insert(schema.peerApprovalRequests).values({
      id: parentId,
      origin: 'https://orbit.example',
      direction: 'outbound',
      instanceName: null,
      hmacSecret: null,
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      approvalToken: null,
    }).run();

    testDb.insert(schema.peerApprovalSubscribers).values([
      {
        id: generateSnowflake(),
        requestId: parentId,
        userId: 'user1',
        triggerReason: 'friend_add',
        triggerTarget: 'someone@orbit.example',
        createdAt: now,
      },
      {
        id: generateSnowflake(),
        requestId: parentId,
        userId: 'user2',
        triggerReason: 'space_join',
        triggerTarget: 'space-x',
        createdAt: now,
      },
    ]).run();

    const { onPeerActivated } = await import('./federationPeerActivation.js');
    await onPeerActivated('peer-active', 'accept_new');

    // 2 approved notifications written.
    const notifs = testDb.select().from(schema.peerApprovalNotifications).all();
    expect(notifs).toHaveLength(2);
    expect(notifs.every(n => n.kind === 'approved')).toBe(true);
    expect(notifs.every(n => n.peerOrigin === 'https://orbit.example')).toBe(true);
    expect(notifs.every(n => n.readAt === null)).toBe(true);

    const userIds = notifs.map(n => n.userId).sort();
    expect(userIds).toEqual(['user1', 'user2']);

    const u1Notif = notifs.find(n => n.userId === 'user1');
    expect(u1Notif?.triggerReason).toBe('friend_add');
    expect(u1Notif?.triggerTarget).toBe('someone@orbit.example');
    const u2Notif = notifs.find(n => n.userId === 'user2');
    expect(u2Notif?.triggerReason).toBe('space_join');
    expect(u2Notif?.triggerTarget).toBe('space-x');

    // Parent deleted, subscribers cascade-deleted.
    const remainingParents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(remainingParents).toHaveLength(0);
    const remainingSubs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(remainingSubs).toHaveLength(0);

    // peering_notification_received WS sent to each subscriber.
    const { connectionManager } = await import('../ws/handler.js');
    expect(connectionManager.sendToUser).toHaveBeenCalledWith('user1', {
      type: 'peering_notification_received',
      kind: 'approved',
    });
    expect(connectionManager.sendToUser).toHaveBeenCalledWith('user2', {
      type: 'peering_notification_received',
      kind: 'approved',
    });
    // Exactly two sendToUser calls (one per subscriber).
    const sendToUserCalls = vi.mocked(connectionManager.sendToUser).mock.calls;
    const peeringCalls = sendToUserCalls.filter(
      c => (c[1] as { type?: string }).type === 'peering_notification_received',
    );
    expect(peeringCalls).toHaveLength(2);

    // sendToAdmins fired (the standard onPeerActivated broadcast).
    expect(connectionManager.sendToAdmins).toHaveBeenCalledWith({
      type: 'federation_peers_changed',
    });
  });

  // ─── Test 11 ────────────────────────────────────────────────────────────
  // onPeerActivated with no outbound queue → no-op fanout (no notifications,
  // no sendToUser calls, no errors). The standard sendToAdmins broadcast
  // still fires (that's onPeerActivated's own concern, not the fanout's).
  it('is a no-op when no outbound queue row exists for the activated origin', async () => {
    seedActivePeer('peer-no-queue', 'https://orphan.example');

    const { onPeerActivated } = await import('./federationPeerActivation.js');
    await expect(onPeerActivated('peer-no-queue', 'health_check_recovery')).resolves.toBeUndefined();

    const notifs = testDb.select().from(schema.peerApprovalNotifications).all();
    expect(notifs).toHaveLength(0);

    const { connectionManager } = await import('../ws/handler.js');
    const sendToUserCalls = vi.mocked(connectionManager.sendToUser).mock.calls;
    const peeringCalls = sendToUserCalls.filter(
      c => (c[1] as { type?: string }).type === 'peering_notification_received',
    );
    expect(peeringCalls).toHaveLength(0);
  });

  // ─── Test 12 ────────────────────────────────────────────────────────────
  // CRITICAL CORRECTNESS PROPERTY: fanout runs regardless of activation
  // path. Here we use reason='initiate_accepted' (admin-initiated via
  // /peer/initiate, NOT via the outbound queue approval handler) and assert
  // the fanout still clears subscribers and notifies them. This proves the
  // centralized cleanup works for any activation path — not just the
  // outbound-approve flow.
  it('fans out and clears even when activated via admin-initiated path (initiate_accepted reason)', async () => {
    seedUser('user1', 'alice');
    seedActivePeer('peer-admin-initiated', 'https://orbit.example');

    const parentId = generateSnowflake();
    const now = Date.now();
    testDb.insert(schema.peerApprovalRequests).values({
      id: parentId,
      origin: 'https://orbit.example',
      direction: 'outbound',
      instanceName: null,
      hmacSecret: null,
      requestedAt: now,
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
      approvalToken: null,
    }).run();

    testDb.insert(schema.peerApprovalSubscribers).values({
      id: generateSnowflake(),
      requestId: parentId,
      userId: 'user1',
      triggerReason: 'friend_add',
      triggerTarget: 'someone@orbit.example',
      createdAt: now,
    }).run();

    const { onPeerActivated } = await import('./federationPeerActivation.js');
    // 'initiate_accepted' = admin used /peer/initiate, bypassing the queue
    // approval handler entirely. The fanout MUST still run.
    await onPeerActivated('peer-admin-initiated', 'initiate_accepted');

    // Subscriber was notified.
    const notifs = testDb.select().from(schema.peerApprovalNotifications).all();
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.kind).toBe('approved');
    expect(notifs[0]!.userId).toBe('user1');
    expect(notifs[0]!.peerOrigin).toBe('https://orbit.example');
    expect(notifs[0]!.triggerReason).toBe('friend_add');
    expect(notifs[0]!.triggerTarget).toBe('someone@orbit.example');

    // Parent + subscriber cascade-cleared.
    const remainingParents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(remainingParents).toHaveLength(0);
    const remainingSubs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(remainingSubs).toHaveLength(0);

    // WS event sent to the subscriber.
    const { connectionManager } = await import('../ws/handler.js');
    expect(connectionManager.sendToUser).toHaveBeenCalledWith('user1', {
      type: 'peering_notification_received',
      kind: 'approved',
    });
  });
});
