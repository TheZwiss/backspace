import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CALLER_ID = 'caller-id';

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
const sendToUser = vi.fn();
const ensurePeeredMock = vi.fn();
const lookupRemoteUserMock = vi.fn();
const resolveOriginFromHostnameMock = vi.fn();

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => { req.userId = CALLER_ID; },
}));
vi.mock('../ws/handler.js', () => ({
  connectionManager: { sendToUser, sendToAdmins: vi.fn(), sendToDmMembers: vi.fn(), getAllOnlineUserIds: () => [] },
}));
vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://home.test' };
});
vi.mock('../utils/federationPeering.js', () => ({
  ensurePeered: (...args: unknown[]) => ensurePeeredMock(...args),
  racePeering: vi.fn(),
}));
vi.mock('../utils/federationLookup.js', () => ({
  lookupRemoteUser: (...args: unknown[]) => lookupRemoteUserMock(...args),
}));
vi.mock('../utils/federationOriginResolve.js', () => ({
  resolveOriginFromHostname: (...args: unknown[]) => resolveOriginFromHostnameMock(...args),
}));

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

function seedSelf(opts: { homeInstance?: string | null; homeUserId?: string | null } = {}): void {
  testDb.insert(schema.users).values({
    id: CALLER_ID,
    username: 'caller',
    displayName: 'Caller',
    passwordHash: 'x',
    status: 'online',
    isAdmin: 0,
    homeInstance: opts.homeInstance ?? null,
    homeUserId: opts.homeUserId ?? null,
    createdAt: Date.now(),
  }).run();
  // Seed instance_settings with relay enabled so queue/log writes are not silently skipped.
  // Use raw exec to avoid the updatedAt NOT NULL constraint (no default in schema).
  sqlite.exec(`INSERT OR IGNORE INTO instance_settings (id, federation_relay_enabled, updated_at) VALUES (1, 1, ${Date.now()})`);
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { socialRoutes } = await import('./social.js');
  await app.register(socialRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  sendToUser.mockReset();
  ensurePeeredMock.mockReset();
  lookupRemoteUserMock.mockReset();
  resolveOriginFromHostnameMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/social/requests — federated branch (happy path)', () => {
  it('creates a stub, inserts the request with relayMessageId, queues a relay event', async () => {
    seedSelf();

    resolveOriginFromHostnameMock.mockReturnValue('https://orbit.test');
    ensurePeeredMock.mockResolvedValue({ status: 'active', peerId: 'peer-1' });
    lookupRemoteUserMock.mockResolvedValue({
      ok: true,
      homeUserId: 'remote-alice',
      username: 'alice',
      profile: {
        displayName: 'Alice',
        avatar: null,
        avatarColor: 'mint',
        banner: null,
        bio: 'hi',
      },
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });

    // Status and body
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { success: boolean; requestId: string };
    expect(body.success).toBe(true);
    expect(typeof body.requestId).toBe('string');

    // friend_requests row
    const reqRow = testDb.select().from(schema.friendRequests)
      .where(eq(schema.friendRequests.id, body.requestId))
      .get();
    expect(reqRow).toBeTruthy();
    expect(reqRow!.fromId).toBe(CALLER_ID);
    expect(reqRow!.relayMessageId).toMatch(/^friend_req:/);

    // Stub user exists with correct federated identity
    const stub = testDb.select().from(schema.users)
      .where(eq(schema.users.homeUserId, 'remote-alice'))
      .get();
    expect(stub).toBeTruthy();
    expect(stub!.homeInstance).toBe('orbit.test');
    expect(stub!.displayName).toBe('Alice');
    expect(stub!.bio).toBe('hi');

    // federation_outbox row
    const peer = testDb.select({ id: schema.federationPeers.id, origin: schema.federationPeers.origin })
      .from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://orbit.test'))
      .get();
    expect(peer).toBeTruthy();

    const outboxRow = testDb.select().from(schema.federationOutbox)
      .where(eq(schema.federationOutbox.peerId, peer!.id))
      .get();
    expect(outboxRow).toBeTruthy();
    expect(outboxRow!.eventType).toBe('friend_request_create');
    expect(outboxRow!.entityId).toBe(reqRow!.relayMessageId);

    // federation_mutation_log row
    const mutationRow = testDb.select().from(schema.federationMutationLog)
      .where(eq(schema.federationMutationLog.entityId, reqRow!.relayMessageId!))
      .get();
    expect(mutationRow).toBeTruthy();

    // WS broadcast to sender — the 'user' field must carry the TARGET's profile (alice),
    // not the sender. This is the federated analogue of the local-branch invariant.
    const sentEvent = sendToUser.mock.calls.find(
      (c: unknown[]) => (c[1] as { type?: string })?.type === 'friend_request_sent',
    );
    expect(sentEvent).toBeDefined();
    expect(sentEvent![0]).toBe(CALLER_ID);
    expect(sentEvent![1].request.id).toBe(body.requestId);
    // homeUserId identifies the target; username is the realname-based stub form
    // (<lookup.username>@<host>) since resolveOrCreateReplicatedUser now uses the
    // username hint from the wire profile snapshot. Falls back to <homeUserId>@<host>
    // only when no hint is available.
    expect(sentEvent![1].request.user.homeUserId).toBe('remote-alice');
    expect(sentEvent![1].request.user.username).toBe('alice@orbit.test');
  });
});

describe('POST /api/social/requests — federated branch (peer status)', () => {
  beforeEach(() => {
    seedSelf();
    resolveOriginFromHostnameMock.mockReturnValue('https://orbit.test');
  });

  it('returns 403 peer_rejected when ensurePeered returns rejected', async () => {
    ensurePeeredMock.mockResolvedValue({ status: 'rejected', error: 'admin must approve' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('peer_rejected');
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
  });

  it('returns 503 peer_unreachable when ensurePeered returns failed', async () => {
    ensurePeeredMock.mockResolvedValue({ status: 'failed', error: 'network' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe('peer_unreachable');
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
  });

  it('returns 409 peer_pending_approval when peering is pending and peer row is awaiting_approval', async () => {
    ensurePeeredMock.mockResolvedValue({ status: 'pending', error: 'awaiting' });
    testDb.insert(schema.federationPeers).values({
      id: 'peer-pending-1',
      origin: 'https://orbit.test',
      hmacSecret: 'secret',
      status: 'awaiting_approval',
      createdAt: Date.now(),
    }).run();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('peer_pending_approval');
  });

  it('returns 409 peer_pending when peering is pending and no peer row exists (handshake in flight)', async () => {
    ensurePeeredMock.mockResolvedValue({ status: 'pending', error: 'in flight' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('peer_pending');
  });
});

describe('POST /api/social/requests — federated branch (lookup failures)', () => {
  beforeEach(() => {
    seedSelf();
    resolveOriginFromHostnameMock.mockReturnValue('https://orbit.test');
    ensurePeeredMock.mockResolvedValue({ status: 'active', peerId: 'p1' });
  });

  it('returns 404 user_not_found when lookup returns not_found', async () => {
    lookupRemoteUserMock.mockResolvedValue({ ok: false, reason: 'not_found' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('user_not_found');
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
  });

  it('returns 503 peer_unreachable when lookup returns unreachable', async () => {
    lookupRemoteUserMock.mockResolvedValue({ ok: false, reason: 'unreachable' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe('peer_unreachable');
  });

  it('returns 429 lookup_rate_limited with Retry-After header when lookup returns rate_limited', async () => {
    lookupRemoteUserMock.mockResolvedValue({ ok: false, reason: 'rate_limited', retryAfter: 30 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).error).toBe('lookup_rate_limited');
    expect(res.headers['retry-after']).toBe('30');
  });

  it('returns 400 invalid_target_domain when resolveOriginFromHostname returns null', async () => {
    resolveOriginFromHostnameMock.mockReturnValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_target_domain');
  });
});

describe('POST /api/social/requests — federated branch (authority + self-friend + idempotency)', () => {
  beforeEach(() => {
    resolveOriginFromHostnameMock.mockReturnValue('https://orbit.test');
    ensurePeeredMock.mockResolvedValue({ status: 'active', peerId: 'p1' });
    lookupRemoteUserMock.mockResolvedValue({
      ok: true, homeUserId: 'remote-alice', username: 'alice',
      profile: { displayName: 'Alice', avatar: null, avatarColor: 'mint', banner: null, bio: null },
    });
  });

  it('returns 403 not_authoritative_for_sender when caller is a federated user', async () => {
    seedSelf({ homeInstance: 'other.test', homeUserId: 'me-elsewhere' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('not_authoritative_for_sender');
  });

  it('passes authority check when sender homeInstance is stored as bare host', async () => {
    // homeInstance stored without scheme — normalizeOriginForCompare('home.test') must
    // equal normalizeOriginForCompare('https://home.test') (T1 invariant).
    seedSelf({ homeInstance: 'home.test', homeUserId: CALLER_ID });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 400 cannot_friend_self when looked-up user is canonical-self', async () => {
    // The dispatcher routes this as federated because targetDomain ('otherhost') is not
    // normalized to our host. resolveOriginFromHostname maps it to our own origin anyway
    // (defense-in-depth: misconfigured or spoofed domain). The lookup returns our own
    // canonical userId, triggering the self-friend check.
    seedSelf();
    resolveOriginFromHostnameMock.mockReturnValue('https://home.test');
    lookupRemoteUserMock.mockResolvedValue({
      ok: true, homeUserId: CALLER_ID, username: 'caller',
      profile: { displayName: 'Caller', avatar: null, avatarColor: 'mint', banner: null, bio: null },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'caller@otherhost' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('cannot_friend_self');
  });

  it('returns 409 already_friends if friendship row exists', async () => {
    seedSelf();
    // Pre-seed stub and friendship
    testDb.insert(schema.users).values({
      id: 'stub-alice',
      username: 'remote-alice@orbit.test',
      displayName: 'Alice',
      passwordHash: '',
      status: 'offline',
      isAdmin: 0,
      homeInstance: 'orbit.test',
      homeUserId: 'remote-alice',
      createdAt: Date.now(),
    }).run();
    testDb.insert(schema.friends).values({
      userId: CALLER_ID,
      friendId: 'stub-alice',
      createdAt: Date.now(),
    }).run();

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('already_friends');
  });

  it('returns 200 + existing requestId when same-direction request already pending (idempotent)', async () => {
    seedSelf();
    // Pre-seed stub and same-direction pending request
    testDb.insert(schema.users).values({
      id: 'stub-alice',
      username: 'remote-alice@orbit.test',
      displayName: 'Alice',
      passwordHash: '',
      status: 'offline',
      isAdmin: 0,
      homeInstance: 'orbit.test',
      homeUserId: 'remote-alice',
      createdAt: Date.now(),
    }).run();
    testDb.insert(schema.friendRequests).values({
      id: 'existing-req',
      fromId: CALLER_ID,
      toId: 'stub-alice',
      status: 'pending',
      createdAt: Date.now(),
    }).run();

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { success: boolean; requestId: string };
    expect(body.requestId).toBe('existing-req');

    // No duplicate row created
    const allRequests = testDb.select().from(schema.friendRequests).all();
    expect(allRequests).toHaveLength(1);
  });

  it('returns 409 incoming_request_exists when opposite-direction request already pending', async () => {
    seedSelf();
    // Pre-seed stub and opposite-direction pending request
    testDb.insert(schema.users).values({
      id: 'stub-alice',
      username: 'remote-alice@orbit.test',
      displayName: 'Alice',
      passwordHash: '',
      status: 'offline',
      isAdmin: 0,
      homeInstance: 'orbit.test',
      homeUserId: 'remote-alice',
      createdAt: Date.now(),
    }).run();
    testDb.insert(schema.friendRequests).values({
      id: 'incoming-req',
      fromId: 'stub-alice',
      toId: CALLER_ID,
      status: 'pending',
      createdAt: Date.now(),
    }).run();

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string; requestId: string };
    expect(body.error).toBe('incoming_request_exists');
    expect(body.requestId).toBe('incoming-req');
  });
});

describe('POST /api/social/requests — federated branch (limbo-window peer_reset_pending)', () => {
  beforeEach(() => {
    seedSelf();
    resolveOriginFromHostnameMock.mockReturnValue('https://orbit.test');
  });

  function seedResetEvent(resolvedAt: number | null): void {
    testDb.insert(schema.federationResetEvents).values({
      origin: 'https://orbit.test',
      deadEpoch: 'dead-epoch',
      newEpoch: resolvedAt === null ? null : 'new-epoch',
      detectedAt: Date.now(),
      resolvedAt,
      stubCount: 1,
      orphanedAccountCount: 0,
    }).run();
  }

  it('returns 409 peer_reset_pending when an UNRESOLVED reset event exists for the target origin', async () => {
    seedResetEvent(null);
    // Even a stale friendship must NOT surface as `already_friends` during the limbo window.
    testDb.insert(schema.users).values({
      id: 'stub-alice',
      username: 'remote-alice@orbit.test',
      displayName: 'Alice',
      passwordHash: '!federation-replicated',
      status: 'offline',
      isAdmin: 0,
      homeInstance: 'orbit.test',
      homeUserId: 'remote-alice-old',
      createdAt: Date.now(),
    }).run();
    testDb.insert(schema.friends).values({
      userId: CALLER_ID,
      friendId: 'stub-alice',
      createdAt: Date.now(),
    }).run();

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('peer_reset_pending');
    // Short-circuits before peering/lookup — neither is consulted.
    expect(ensurePeeredMock).not.toHaveBeenCalled();
    expect(lookupRemoteUserMock).not.toHaveBeenCalled();
    // No new request row created.
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
  });

  it('proceeds normally when the reset event is RESOLVED (resolved_at set)', async () => {
    seedResetEvent(Date.now());
    ensurePeeredMock.mockResolvedValue({ status: 'active', peerId: 'peer-1' });
    lookupRemoteUserMock.mockResolvedValue({
      ok: true,
      homeUserId: 'remote-alice',
      username: 'alice',
      profile: { displayName: 'Alice', avatar: null, avatarColor: 'mint', banner: null, bio: null },
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });

    expect(res.statusCode).toBe(201);
    expect(ensurePeeredMock).toHaveBeenCalled();
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('proceeds normally when NO reset event exists for the origin', async () => {
    ensurePeeredMock.mockResolvedValue({ status: 'active', peerId: 'peer-1' });
    lookupRemoteUserMock.mockResolvedValue({
      ok: true,
      homeUserId: 'remote-alice',
      username: 'alice',
      profile: { displayName: 'Alice', avatar: null, avatarColor: 'mint', banner: null, bio: null },
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'alice@orbit.test' },
    });

    expect(res.statusCode).toBe(201);
    expect(ensurePeeredMock).toHaveBeenCalled();
  });
});
