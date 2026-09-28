import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { LookupResult } from '../utils/federationLookup.js';

setWorkerId(1);

/**
 * A remote user first met through a client route (the "Message" button, a
 * group DM, adding a member) gets the name their home instance reports, not a
 * `<homeUserId>@<domain>` placeholder. When the home cannot be asked, the row
 * falls back to the placeholder and is renamed the next time a trusted
 * username for it arrives.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const lookupResponses = new Map<string, LookupResult>();
const lookupCalls: Array<{ peerOrigin: string; homeUserId: string }> = [];
/** How long each mocked home takes to answer, and how many were asked at once. */
let lookupDelayMs = 0;
let lookupsInFlight = 0;
let maxLookupsInFlight = 0;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => { req.userId = 'first-admin'; },
}));
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(), sendToDmMembers: vi.fn(), sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [], getRoom: () => undefined, getUserRoom: () => undefined,
    leaveCurrentRoom: vi.fn(() => false), destroyRoom: vi.fn(), clearVoiceUserStatus: vi.fn(),
  },
}));
vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return { ...actual, isFederationRelayEnabled: () => true, queueDmCloseRelay: vi.fn(), sendTypingRelay: vi.fn(), queueDmRelay: vi.fn(), queueGroupMetadataRelay: vi.fn() };
});
vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://test.example' };
});
vi.mock('../utils/federationLookup.js', () => ({
  lookupRemoteUser: vi.fn(async () => ({ ok: false, reason: 'unreachable' })),
  lookupRemoteUserByHomeId: vi.fn(async (peerOrigin: string, homeUserId: string): Promise<LookupResult> => {
    lookupCalls.push({ peerOrigin, homeUserId });
    lookupsInFlight++;
    maxLookupsInFlight = Math.max(maxLookupsInFlight, lookupsInFlight);
    try {
      if (lookupDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, lookupDelayMs));
      return lookupResponses.get(homeUserId) ?? { ok: false, reason: 'unreachable' };
    } finally {
      lookupsInFlight--;
    }
  }),
}));

import { connectionManager } from '../ws/handler.js';

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const KAI_ID = '1234567890123456789';
const LEA_ID = '1234567890123456790';
const MIA_ID = '1234567890123456791';

function found(homeUserId: string, username: string, displayName: string | null): LookupResult {
  return {
    ok: true,
    homeUserId,
    username,
    profile: { displayName, avatar: null, avatarColor: null, banner: null, bio: null, status: 'online' },
  };
}

type MemberView = { id: string; username: string; displayName: string | null; homeUserId: string | null };

function userByHomeId(homeUserId: string): typeof schema.users.$inferSelect | undefined {
  return testDb.select().from(schema.users).where(eq(schema.users.homeUserId, homeUserId)).get();
}

function seedIdNamedFriend(id: string, homeUserId: string): void {
  testDb.insert(schema.users).values({
    id, username: `${homeUserId}@friend.example`, displayName: null,
    passwordHash: '!federation-replicated', homeInstance: 'friend.example', homeUserId, createdAt: Date.now(),
  }).run();
  testDb.insert(schema.friends).values({ userId: 'first-admin', friendId: id, createdAt: Date.now() }).run();
}

describe('a remote user first met through a client route is named from their home', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    lookupResponses.clear();
    lookupCalls.length = 0;
    lookupDelayMs = 0;
    lookupsInFlight = 0;
    maxLookupsInFlight = 0;
    const { _resetHomeLookupCache } = await import('../utils/federationClientIdentity.js');
    _resetHomeLookupCache();
    vi.mocked(connectionManager.sendToUser).mockClear();
    testDb.insert(schema.instanceSettings).values({ id: 1, federationRelayEnabled: 1, updatedAt: Date.now() }).run();
    testDb.insert(schema.users).values({ id: 'first-admin', username: 'quddy', passwordHash: 'x', isAdmin: 1, createdAt: Date.now() }).run();
    testDb.insert(schema.federationPeers).values({
      id: 'peer-friend',
      origin: 'https://friend.example',
      hmacSecret: 'a'.repeat(64),
      status: 'active',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }).run();
    app = Fastify({ logger: false });
    const { dmRoutes } = await import('./dm.js');
    await app.register(dmRoutes);
    await app.ready();
  });

  it('POST /api/dm names the remote user by the username and display name their home reports', async () => {
    lookupResponses.set(KAI_ID, found(KAI_ID, 'kai', 'Kai'));
    const res = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: KAI_ID, homeInstance: 'friend.example' },
    });
    expect(res.statusCode).toBe(201);
    const other = (res.json() as { members: MemberView[] }).members.find((m) => m.homeUserId === KAI_ID)!;
    expect(other.username).toBe('kai@friend.example');
    expect(other.displayName).toBe('Kai');
    expect(lookupCalls).toEqual([{ peerOrigin: 'https://friend.example', homeUserId: KAI_ID }]);
  });

  it('POST /api/dm falls back to an id-named row when the home cannot be asked, and a later username hint renames it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: KAI_ID, homeInstance: 'friend.example' },
    });
    expect(res.statusCode).toBe(201);
    const other = (res.json() as { members: MemberView[] }).members.find((m) => m.homeUserId === KAI_ID)!;
    expect(other.username).toBe(`${KAI_ID}@friend.example`);

    // A relayed message or a friend-add later carries the real username.
    const { resolveOrCreateReplicatedUser } = await import('./federation.js');
    const resolved = resolveOrCreateReplicatedUser(KAI_ID, 'friend.example', testDb, { username: 'kai' });
    expect(resolved?.id).toBe(other.id);
    expect(resolved?.username).toBe('kai@friend.example');
    expect(userByHomeId(KAI_ID)?.username).toBe('kai@friend.example');

    // The DM partner's open clients learn the new name.
    const sends = vi.mocked(connectionManager.sendToUser).mock.calls
      .filter(([, event]) => (event as { type: string }).type === 'user_updated');
    const toAdmin = sends.find(([uid]) => uid === 'first-admin');
    expect(toAdmin).toBeDefined();
    expect((toAdmin![1] as { user: { username: string } }).user.username).toBe('kai@friend.example');
  });

  it('POST /api/dm renames an existing id-named row when the home answers', async () => {
    testDb.insert(schema.users).values({
      id: 'stub-kai', username: `${KAI_ID}@friend.example`, displayName: null,
      passwordHash: '!federation-replicated', homeInstance: 'friend.example', homeUserId: KAI_ID, createdAt: Date.now(),
    }).run();
    lookupResponses.set(KAI_ID, found(KAI_ID, 'kai', 'Kai'));
    const res = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: KAI_ID, homeInstance: 'friend.example' },
    });
    expect(res.statusCode).toBe(201);
    const other = (res.json() as { members: MemberView[] }).members.find((m) => m.homeUserId === KAI_ID)!;
    expect(other.id).toBe('stub-kai');
    expect(other.username).toBe('kai@friend.example');
    expect(other.displayName).toBe('Kai');
  });

  it('POST /api/dm does not ask the home again for a row that already has its real name', async () => {
    testDb.insert(schema.users).values({
      id: 'stub-kai', username: 'kai@friend.example', displayName: 'Kai',
      passwordHash: '!federation-replicated', homeInstance: 'friend.example', homeUserId: KAI_ID, createdAt: Date.now(),
    }).run();
    const res = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: KAI_ID, homeInstance: 'friend.example' },
    });
    expect(res.statusCode).toBe(201);
    expect(lookupCalls).toEqual([]);
  });

  it('POST /api/dm/group renames id-named friends from their home', async () => {
    seedIdNamedFriend('stub-kai', KAI_ID);
    seedIdNamedFriend('stub-lea', LEA_ID);
    lookupResponses.set(KAI_ID, found(KAI_ID, 'kai', 'Kai'));
    lookupResponses.set(LEA_ID, found(LEA_ID, 'lea', null));
    const res = await app.inject({
      method: 'POST', url: '/api/dm/group',
      payload: { users: [
        { id: KAI_ID, homeUserId: KAI_ID, homeInstance: 'friend.example' },
        { id: LEA_ID, homeUserId: LEA_ID, homeInstance: 'friend.example' },
      ] },
    });
    expect(res.statusCode).toBe(201);
    expect(userByHomeId(KAI_ID)?.username).toBe('kai@friend.example');
    expect(userByHomeId(KAI_ID)?.displayName).toBe('Kai');
    expect(userByHomeId(LEA_ID)?.username).toBe('lea@friend.example');
    expect(userByHomeId(LEA_ID)?.displayName).toBe('lea');
  });

  it('POST /api/dm/:id/members renames an id-named friend from their home', async () => {
    seedIdNamedFriend('stub-kai', KAI_ID);
    seedIdNamedFriend('stub-lea', LEA_ID);
    seedIdNamedFriend('stub-mia', MIA_ID);
    const group = await app.inject({
      method: 'POST', url: '/api/dm/group',
      payload: { users: [{ id: 'stub-kai' }, { id: 'stub-lea' }] },
    });
    expect(group.statusCode).toBe(201);
    const groupId = (group.json() as { id: string }).id;
    lookupResponses.set(MIA_ID, found(MIA_ID, 'mia', 'Mia'));
    const res = await app.inject({
      method: 'POST', url: `/api/dm/${groupId}/members`,
      payload: { homeUserId: MIA_ID, homeInstance: 'friend.example' },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(userByHomeId(MIA_ID)?.id).toBe('stub-mia');
    expect(userByHomeId(MIA_ID)?.username).toBe('mia@friend.example');
    expect(userByHomeId(MIA_ID)?.displayName).toBe('Mia');
  });

  it('POST /api/dm/group asks the homes of its members at the same time', async () => {
    seedIdNamedFriend('stub-kai', KAI_ID);
    seedIdNamedFriend('stub-lea', LEA_ID);
    lookupResponses.set(KAI_ID, found(KAI_ID, 'kai', 'Kai'));
    lookupResponses.set(LEA_ID, found(LEA_ID, 'lea', 'Lea'));
    lookupDelayMs = 200;
    const res = await app.inject({
      method: 'POST', url: '/api/dm/group',
      payload: { users: [
        { id: KAI_ID, homeUserId: KAI_ID, homeInstance: 'friend.example' },
        { id: LEA_ID, homeUserId: LEA_ID, homeInstance: 'friend.example' },
      ] },
    });
    expect(res.statusCode).toBe(201);
    expect(maxLookupsInFlight).toBe(2);
  });

  it('POST /api/dm does not ask the home again right after it could not answer', async () => {
    const first = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: KAI_ID, homeInstance: 'friend.example' },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: KAI_ID, homeInstance: 'friend.example' },
    });
    expect(second.statusCode).toBeLessThan(300);
    expect(lookupCalls).toHaveLength(1);
  });
});
