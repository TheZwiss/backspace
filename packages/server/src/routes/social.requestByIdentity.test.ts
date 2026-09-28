// POST /api/social/requests addressed by federated identity ({ homeUserId,
// homeInstance }) rather than by a username string. A client that holds a
// user object already knows who it means; the local row's username is only a
// label and, for a replicated stub minted without a name hint, is
// `<homeUserId>@<domain>`, which the peer's by-name lookup cannot resolve.
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
const REMOTE_HOME_ID = '342939417492520960';

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
const sendToUser = vi.fn();
const ensurePeeredMock = vi.fn();
const lookupRemoteUserMock = vi.fn();
const lookupRemoteUserByHomeIdMock = vi.fn();
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
vi.mock('../utils/federationPeering.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationPeering.js')>();
  return {
    ...actual,
    ensurePeered: (...args: unknown[]) => ensurePeeredMock(...args),
    racePeering: vi.fn(),
  };
});
vi.mock('../utils/federationLookup.js', () => ({
  lookupRemoteUser: (...args: unknown[]) => lookupRemoteUserMock(...args),
  lookupRemoteUserByHomeId: (...args: unknown[]) => lookupRemoteUserByHomeIdMock(...args),
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

function seedUser(id: string, username: string, extra: Partial<typeof schema.users.$inferInsert> = {}): void {
  testDb.insert(schema.users).values({
    id,
    username,
    passwordHash: 'x',
    status: 'online',
    isAdmin: 0,
    createdAt: Date.now(),
    ...extra,
  }).run();
}

/** The peer's answer for its native user yoko, by name or by home id. */
const YOKO = {
  ok: true as const,
  homeUserId: REMOTE_HOME_ID,
  username: 'yoko',
  profile: { displayName: 'Yoko', avatar: null, avatarColor: null, banner: null, bio: null, status: 'online' as const },
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { socialRoutes } = await import('./social.js');
  await app.register(socialRoutes);
  await app.ready();
  return app;
}

function errorCode(body: string): string | undefined {
  const parsed = JSON.parse(body) as { code?: string; error?: string };
  return parsed.code ?? parsed.error;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  sendToUser.mockReset();
  ensurePeeredMock.mockReset();
  lookupRemoteUserMock.mockReset();
  lookupRemoteUserByHomeIdMock.mockReset();
  resolveOriginFromHostnameMock.mockReset();

  seedUser(CALLER_ID, 'caller');
  sqlite.exec(`INSERT OR IGNORE INTO instance_settings (id, federation_relay_enabled, updated_at) VALUES (1, 1, ${Date.now()})`);
  resolveOriginFromHostnameMock.mockImplementation((host: string) => (host === 'orbit.test' ? 'https://orbit.test' : null));
  ensurePeeredMock.mockResolvedValue({ status: 'active', peerId: 'peer-orbit' });
  // The peer's by-name lookup matches native usernames only.
  lookupRemoteUserMock.mockImplementation(async (_origin: string, name: string) => (
    name === 'yoko' ? YOKO : { ok: false, reason: 'not_found' }
  ));
  lookupRemoteUserByHomeIdMock.mockImplementation(async (_origin: string, homeUserId: string) => (
    homeUserId === REMOTE_HOME_ID ? YOKO : { ok: false, reason: 'not_found' }
  ));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/social/requests by identity: remote target', () => {
  it('resolves the target by home id, so a stub named <homeUserId>@<domain> can be re-added', async () => {
    // What POST /api/dm leaves behind for a person first reached by identity:
    // a stub named after the home id, which no peer username lookup matches.
    const { resolveOrCreateReplicatedUser } = await import('./federation/identity.js');
    const stub = resolveOrCreateReplicatedUser(REMOTE_HOME_ID, 'orbit.test', testDb);
    expect(stub?.username).toBe(`${REMOTE_HOME_ID}@orbit.test`);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      // A new client sends the identity and, for older servers, the username.
      payload: { username: stub!.username, homeUserId: REMOTE_HOME_ID, homeInstance: 'orbit.test' },
    });

    expect(res.statusCode).toBe(201);
    expect(lookupRemoteUserByHomeIdMock).toHaveBeenCalledWith('https://orbit.test', REMOTE_HOME_ID);
    expect(lookupRemoteUserMock).not.toHaveBeenCalled();

    // The request binds the existing stub; no second row is minted for the person.
    const { requestId } = JSON.parse(res.body) as { requestId: string };
    const row = testDb.select().from(schema.friendRequests).where(eq(schema.friendRequests.id, requestId)).get();
    expect(row?.fromId).toBe(CALLER_ID);
    expect(row?.toId).toBe(stub!.id);
    expect(testDb.select().from(schema.users).where(eq(schema.users.homeUserId, REMOTE_HOME_ID)).all()).toHaveLength(1);

    // The same outbox step as the by-name path.
    const outbox = testDb.select().from(schema.federationOutbox).all();
    expect(outbox.map(o => o.eventType)).toEqual(['friend_request_create']);
    expect(outbox[0]!.entityId).toBe(row!.relayMessageId);
  });

  it('accepts a homeInstance given as a full origin', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { homeUserId: REMOTE_HOME_ID, homeInstance: 'https://orbit.test' },
    });
    expect(res.statusCode).toBe(201);
    expect(lookupRemoteUserByHomeIdMock).toHaveBeenCalledWith('https://orbit.test', REMOTE_HOME_ID);
  });

  it('is idempotent for a request already pending to the same identity', async () => {
    const app = await buildApp();
    const payload = { homeUserId: REMOTE_HOME_ID, homeInstance: 'orbit.test' };
    const first = await app.inject({ method: 'POST', url: '/api/social/requests', payload });
    const second = await app.inject({ method: 'POST', url: '/api/social/requests', payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect((JSON.parse(second.body) as { requestId: string }).requestId)
      .toBe((JSON.parse(first.body) as { requestId: string }).requestId);
  });

  it('answers user_not_found when the peer hosts no native user with that home id', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { homeUserId: 'someone-else', homeInstance: 'orbit.test' },
    });
    expect(res.statusCode).toBe(404);
    expect(errorCode(res.body)).toBe('user_not_found');
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
  });

  it('answers peer_unreachable when the peer cannot answer the home id lookup', async () => {
    // What lookupRemoteUserByHomeId returns for an HTTP error, a transport
    // failure or a malformed body; it throws only when the peer row is missing.
    lookupRemoteUserByHomeIdMock.mockResolvedValue({ ok: false, reason: 'unreachable' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { homeUserId: REMOTE_HOME_ID, homeInstance: 'orbit.test' },
    });
    expect(res.statusCode).toBe(503);
    expect(errorCode(res.body)).toBe('peer_unreachable');
  });

  it('answers lookup_rate_limited with Retry-After when the peer limits the home id lookup', async () => {
    lookupRemoteUserByHomeIdMock.mockResolvedValue({ ok: false, reason: 'rate_limited', retryAfter: 42 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { homeUserId: REMOTE_HOME_ID, homeInstance: 'orbit.test' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
  });
});

describe('POST /api/social/requests by identity: local target', () => {
  it('finds a native user of this instance by id, without asking any peer', async () => {
    seedUser('bob-id', 'bob');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'not-bobs-name', homeUserId: 'bob-id', homeInstance: 'home.test' },
    });
    expect(res.statusCode).toBe(201);
    const { requestId } = JSON.parse(res.body) as { requestId: string };
    const row = testDb.select().from(schema.friendRequests).where(eq(schema.friendRequests.id, requestId)).get();
    expect(row?.toId).toBe('bob-id');
    expect(lookupRemoteUserMock).not.toHaveBeenCalled();
    expect(lookupRemoteUserByHomeIdMock).not.toHaveBeenCalled();
    expect(ensurePeeredMock).not.toHaveBeenCalled();
  });

  it('treats the same host on another port as another instance', async () => {
    // home.test:8443 is not this instance (home.test): no local lookup by id.
    seedUser('bob-id', 'bob');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { homeUserId: 'bob-id', homeInstance: 'home.test:8443' },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.body)).toBe('invalid_target_domain');
    expect(testDb.select().from(schema.friendRequests).all()).toHaveLength(0);
  });

  it('answers cannot_friend_self when the identity is the sender', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { homeUserId: CALLER_ID, homeInstance: 'https://home.test' },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.body)).toBe('cannot_friend_self');
  });

  it('answers user_not_found for an id that is not a native user here', async () => {
    // A replicated row's local id is not an identity of this instance.
    seedUser('stub-row', 'someone@orbit.test', { homeInstance: 'orbit.test', homeUserId: 'someone' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { homeUserId: 'stub-row', homeInstance: 'home.test' },
    });
    expect(res.statusCode).toBe(404);
    expect(errorCode(res.body)).toBe('user_not_found');
  });
});

describe('POST /api/social/requests: which field names the target', () => {
  it('refuses an identity with only one of homeUserId and homeInstance as validation_failed', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'yoko@orbit.test', homeUserId: REMOTE_HOME_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.body)).toBe('validation_failed');
    expect(lookupRemoteUserMock).not.toHaveBeenCalled();
  });

  it('keeps the by-name lookup for a typed handle', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/social/requests',
      payload: { username: 'yoko@orbit.test' },
    });
    expect(res.statusCode).toBe(201);
    expect(lookupRemoteUserMock).toHaveBeenCalledWith('https://orbit.test', 'yoko');
    expect(lookupRemoteUserByHomeIdMock).not.toHaveBeenCalled();
  });

  it('answers username_required when neither a username nor an identity is given', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/social/requests', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.body)).toBe('username_required');
  });
});
