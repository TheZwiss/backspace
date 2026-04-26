import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('./federationAuth.js', async () => {
  const actual = await vi.importActual<typeof import('./federationAuth.js')>('./federationAuth.js');
  return {
    ...actual,
    getOurOrigin: () => 'https://local.example',
    generateHmacSecret: () => 'mock-hmac-secret',
  };
});

vi.mock('../routes/federation.js', () => ({
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
  },
}));

vi.mock('./federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(async () => undefined),
  onPeerDeactivated: vi.fn(async () => undefined),
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

function seedInstanceSettings(autoAcceptPeering: 0 | 1): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceName: 'Local Backspace',
    autoAcceptPeering,
    registrationOpen: 1,
    updatedAt: Date.now(),
  }).run();
}

function seedUser(id: string, username: string): void {
  testDb.insert(schema.users).values({
    id,
    username,
    passwordHash: 'x',
    createdAt: Date.now(),
  }).run();
}

describe('ensurePeered — outbound gate behavior across (autoAccept × peer-row × intent)', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    const { _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sqlite.close();
  });

  // ─── Test 1 ─────────────────────────────────────────────────────────────
  // autoAccept=1 + no peer + user_action → gate does NOT fire; pending peer
  // row created; handshake runs as today.
  it('autoAccept=1 + no peer + user_action → no gate; pending peer row created; handshake runs', async () => {
    seedInstanceSettings(1);
    seedUser('user1', 'alice');

    // Stub fetch with a network failure so the handshake resolves as 'failed'
    // (transient) without us needing a complete 200/202 response. The peer row
    // is created BEFORE fetch in performHandshake, then deleted on transient
    // failure. So we assert the row existed mid-flight by spying on fetch and
    // capturing DB state at that point.
    let peerRowsDuringHandshake: Array<{ status: string; origin: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      peerRowsDuringHandshake = testDb
        .select({ status: schema.federationPeers.status, origin: schema.federationPeers.origin })
        .from(schema.federationPeers)
        .all();
      throw new TypeError('fetch failed');
    }));

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://orbit.example', {
      kind: 'user_action',
      userId: 'user1',
      reason: 'friend_add',
      target: 'bob@orbit.example',
    });

    // Handshake reached fetch (gate did not fire). Network failure → 'failed'.
    expect(result.status).toBe('failed');

    // Mid-handshake, the pending peer row existed.
    expect(peerRowsDuringHandshake).toHaveLength(1);
    expect(peerRowsDuringHandshake[0].status).toBe('pending');
    expect(peerRowsDuringHandshake[0].origin).toBe('https://orbit.example');

    // No outbound queue rows were created.
    const parents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(parents).toHaveLength(0);
    const subs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(subs).toHaveLength(0);
  });

  // ─── Test 2 ─────────────────────────────────────────────────────────────
  // autoAccept=0 + no peer + user_action → gate fires; outbound queue parent
  // + subscriber created; returns 'admin_required'; no peer row created.
  it('autoAccept=0 + no peer + user_action → queues outbound row + subscriber; no peer row; admin_required', async () => {
    seedInstanceSettings(0);
    seedUser('user1', 'alice');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://orbit.example', {
      kind: 'user_action',
      userId: 'user1',
      reason: 'friend_add',
      target: 'bob@orbit.example',
    });

    expect(result.status).toBe('admin_required');

    // Parent row created.
    const parents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(parents).toHaveLength(1);
    expect(parents[0].direction).toBe('outbound');
    expect(parents[0].origin).toBe('https://orbit.example');
    expect(parents[0].hmacSecret).toBeNull();

    // Subscriber row created.
    const subs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(subs).toHaveLength(1);
    expect(subs[0].userId).toBe('user1');
    expect(subs[0].triggerReason).toBe('friend_add');
    expect(subs[0].triggerTarget).toBe('bob@orbit.example');
    expect(subs[0].requestId).toBe(parents[0].id);

    // No federation_peers row created; no outbound POST attempted.
    const peers = testDb.select().from(schema.federationPeers).all();
    expect(peers).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ─── Test 3 ─────────────────────────────────────────────────────────────
  // autoAccept=0 + no peer + system intent → gate fires; no queue row created;
  // zero subscribers; returns 'admin_required'.
  it('autoAccept=0 + no peer + system intent → admin_required; no queue, no subscribers', async () => {
    seedInstanceSettings(0);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://orbit.example', { kind: 'system' });

    expect(result.status).toBe('admin_required');

    const parents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(parents).toHaveLength(0);
    const subs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(subs).toHaveLength(0);
    const peers = testDb.select().from(schema.federationPeers).all();
    expect(peers).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ─── Test 4 ─────────────────────────────────────────────────────────────
  // autoAccept=0 + existing active peer row + any intent → gate skipped;
  // returns 'active' with existing peerId.
  it('autoAccept=0 + existing active peer row → returns active; gate skipped', async () => {
    seedInstanceSettings(0);
    seedUser('user1', 'alice');

    testDb.insert(schema.federationPeers).values({
      id: 'peer-active',
      origin: 'https://orbit.example',
      hmacSecret: 'secret',
      status: 'active',
      createdAt: Date.now(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://orbit.example', {
      kind: 'user_action',
      userId: 'user1',
      reason: 'friend_add',
      target: 'bob@orbit.example',
    });

    expect(result.status).toBe('active');
    if (result.status === 'active') {
      expect(result.peerId).toBe('peer-active');
    }

    // No queue rows; no outbound POST.
    const parents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(parents).toHaveLength(0);
    const subs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(subs).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ─── Test 5 ─────────────────────────────────────────────────────────────
  // autoAccept=0 + existing pending peer row + user_action → gate skipped
  // (existing path handles); existing dedup/inflight logic runs.
  it('autoAccept=0 + existing pending peer row + user_action → gate skipped; reaches handshake (dedup path)', async () => {
    seedInstanceSettings(0);
    seedUser('user1', 'alice');

    testDb.insert(schema.federationPeers).values({
      id: 'peer-pending',
      origin: 'https://orbit.example',
      hmacSecret: 'old-secret',
      status: 'pending',
      createdAt: Date.now(),
    }).run();

    // The pending branch falls through to performHandshake which calls fetch.
    // Stub it to fail transiently — the handshake will keep the existing peer
    // row (existingPeerId is set, so it isn't deleted on failure).
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://orbit.example', {
      kind: 'user_action',
      userId: 'user1',
      reason: 'friend_add',
      target: 'bob@orbit.example',
    });

    // Reached performHandshake — failure mode is 'failed', NOT 'admin_required'.
    expect(result.status).toBe('failed');
    expect(fetchSpy).toHaveBeenCalled();

    // Critically: the gate did NOT queue an outbound approval row.
    const parents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(parents).toHaveLength(0);
    const subs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(subs).toHaveLength(0);

    // Existing pending peer row still present (existingPeerId path doesn't delete on failure).
    const peers = testDb.select().from(schema.federationPeers).all();
    expect(peers).toHaveLength(1);
    expect(peers[0].id).toBe('peer-pending');
  });

  // ─── Test 6 ─────────────────────────────────────────────────────────────
  // autoAccept=0 + existing rejected peer row + user_action → gate skipped;
  // returns 'rejected' per existing branch (no queue creation).
  it('autoAccept=0 + existing rejected peer row + user_action → returns rejected; gate does NOT override', async () => {
    seedInstanceSettings(0);
    seedUser('user1', 'alice');

    testDb.insert(schema.federationPeers).values({
      id: 'peer-rejected',
      origin: 'https://orbit.example',
      hmacSecret: 'secret',
      status: 'rejected',
      createdAt: Date.now(),
    }).run();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://orbit.example', {
      kind: 'user_action',
      userId: 'user1',
      reason: 'friend_add',
      target: 'bob@orbit.example',
    });

    expect(result.status).toBe('rejected');

    // CRITICAL: no queue row created — the gate did NOT override the rejected branch.
    const parents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(parents).toHaveLength(0);
    const subs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(subs).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Rejected peer row unchanged.
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, 'peer-rejected')).get();
    expect(peer?.status).toBe('rejected');
  });

  // ─── Test 7 ─────────────────────────────────────────────────────────────
  // autoAccept=0 + same user calls twice with same target → upsert path; one
  // parent row, one subscriber row, refreshed created_at.
  it('autoAccept=0 + same user calls twice with same target → idempotent: 1 parent, 1 subscriber, refreshed createdAt', async () => {
    seedInstanceSettings(0);
    seedUser('user1', 'alice');

    const { ensurePeered } = await import('./federationPeering.js');

    const result1 = await ensurePeered('https://orbit.example', {
      kind: 'user_action',
      userId: 'user1',
      reason: 'friend_add',
      target: 'bob@orbit.example',
    });
    expect(result1.status).toBe('admin_required');

    const subsAfterFirst = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(subsAfterFirst).toHaveLength(1);
    const firstCreatedAt = subsAfterFirst[0].createdAt;

    // Wait a moment so the refreshed createdAt would differ.
    await new Promise(r => setTimeout(r, 5));

    const result2 = await ensurePeered('https://orbit.example', {
      kind: 'user_action',
      userId: 'user1',
      reason: 'friend_add',
      target: 'bob@orbit.example',
    });
    expect(result2.status).toBe('admin_required');

    // Still exactly one parent row keyed on (origin, direction='outbound').
    const parents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(parents).toHaveLength(1);
    expect(parents[0].direction).toBe('outbound');
    expect(parents[0].origin).toBe('https://orbit.example');

    // Still exactly one subscriber keyed on (request_id, user_id, reason, target).
    const subs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(subs).toHaveLength(1);
    expect(subs[0].userId).toBe('user1');
    expect(subs[0].triggerReason).toBe('friend_add');
    expect(subs[0].triggerTarget).toBe('bob@orbit.example');

    // createdAt was refreshed on the second call.
    expect(subs[0].createdAt).toBeGreaterThan(firstCreatedAt);
  });

  // ─── Test 8 ─────────────────────────────────────────────────────────────
  // autoAccept=0 + two users call with same target → one parent row, two
  // subscriber rows.
  it('autoAccept=0 + two users call with same target → 1 parent, 2 subscribers (m:n fanout)', async () => {
    seedInstanceSettings(0);
    seedUser('user1', 'alice');
    seedUser('user2', 'carol');

    const { ensurePeered } = await import('./federationPeering.js');

    const result1 = await ensurePeered('https://orbit.example', {
      kind: 'user_action',
      userId: 'user1',
      reason: 'friend_add',
      target: 'bob@orbit.example',
    });
    expect(result1.status).toBe('admin_required');

    const result2 = await ensurePeered('https://orbit.example', {
      kind: 'user_action',
      userId: 'user2',
      reason: 'friend_add',
      target: 'bob@orbit.example',
    });
    expect(result2.status).toBe('admin_required');

    // Exactly one parent row.
    const parents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(parents).toHaveLength(1);
    expect(parents[0].origin).toBe('https://orbit.example');
    expect(parents[0].direction).toBe('outbound');

    // Two subscribers, both pointing at the same parent.
    const subs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(subs).toHaveLength(2);
    const userIds = subs.map(s => s.userId).sort();
    expect(userIds).toEqual(['user1', 'user2']);
    for (const sub of subs) {
      expect(sub.requestId).toBe(parents[0].id);
      expect(sub.triggerReason).toBe('friend_add');
      expect(sub.triggerTarget).toBe('bob@orbit.example');
    }
  });

  // ─── Test 9 ─────────────────────────────────────────────────────────────
  // autoAccept=0 + user_action with reason='space_join' → subscriber row
  // records correct reason and target.
  it('autoAccept=0 + user_action reason=space_join → subscriber records correct reason/target', async () => {
    seedInstanceSettings(0);
    seedUser('user1', 'alice');

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://orbit.example', {
      kind: 'user_action',
      userId: 'user1',
      reason: 'space_join',
      target: 'space-abc-123',
    });

    expect(result.status).toBe('admin_required');

    const subs = testDb.select().from(schema.peerApprovalSubscribers).all();
    expect(subs).toHaveLength(1);
    expect(subs[0].userId).toBe('user1');
    expect(subs[0].triggerReason).toBe('space_join');
    expect(subs[0].triggerTarget).toBe('space-abc-123');

    const parents = testDb.select().from(schema.peerApprovalRequests).all();
    expect(parents).toHaveLength(1);
    expect(parents[0].direction).toBe('outbound');
    expect(parents[0].origin).toBe('https://orbit.example');
  });
});
