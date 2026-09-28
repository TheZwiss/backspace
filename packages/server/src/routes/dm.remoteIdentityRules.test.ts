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
 * The rules a DM route follows before it creates a row for a remote identity a
 * local client names: the home id is shaped like a snowflake, the home does not
 * deny the id, and the name comes from the home, never from the request body.
 * An identity whose home is not (yet) an active peer still gets its row under
 * the id name, as first contact always did; the DM's first message starts the
 * peering. A row that already exists still resolves.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const lookupResponses = new Map<string, LookupResult>();
const lookupCalls: Array<{ peerOrigin: string; homeUserId: string }> = [];

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
    return lookupResponses.get(homeUserId) ?? { ok: false, reason: 'unreachable' };
  }),
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

type MemberView = { id: string; username: string; displayName: string | null; homeUserId: string | null };

function userByHomeId(homeUserId: string): typeof schema.users.$inferSelect | undefined {
  return testDb.select().from(schema.users).where(eq(schema.users.homeUserId, homeUserId)).get();
}

const NEW_ID = '1234567890123456799';

function remoteRowCount(): number {
  return testDb.select().from(schema.users).all().filter((u) => u.homeInstance !== null).length;
}

describe('rules for creating a row for a remote identity named by a client', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    lookupResponses.clear();
    lookupCalls.length = 0;
    const { _resetHomeLookupCache } = await import('../utils/federationClientIdentity.js');
    _resetHomeLookupCache();
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

  it('a home id that is not a snowflake names no one: 404, no row, no lookup', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: 'kai', homeInstance: 'friend.example' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('user_not_found');
    expect(remoteRowCount()).toBe(0);
    expect(lookupCalls).toEqual([]);
  });

  it('an identity whose home is not yet an active peer gets an id-named row and a relayable DM', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: NEW_ID, homeInstance: 'unpeered.example' },
    });
    expect(res.statusCode).toBe(201);
    // The DM carries a federatedId, so its first message is queued for the
    // identity's instance and that relay starts the peering, as before.
    expect((res.json() as { federatedId: string | null }).federatedId).toMatch(/^[a-f0-9]{32}$/);
    expect(userByHomeId(NEW_ID)?.username).toBe(`${NEW_ID}@unpeered.example`);
    expect(lookupCalls).toEqual([]);
  });

  for (const status of ['pending', 'awaiting_approval', 'unreachable'] as const) {
    it(`an identity whose peering is ${status} gets an id-named row without a lookup`, async () => {
      testDb.update(schema.federationPeers).set({ status }).run();
      const res = await app.inject({
        method: 'POST', url: '/api/dm',
        payload: { homeUserId: NEW_ID, homeInstance: 'friend.example' },
      });
      expect(res.statusCode).toBe(201);
      expect(userByHomeId(NEW_ID)?.username).toBe(`${NEW_ID}@friend.example`);
      expect(lookupCalls).toEqual([]);
    });
  }

  it('an id the home says does not exist gets no new row', async () => {
    lookupResponses.set(NEW_ID, { ok: false, reason: 'not_found' });
    const res = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: NEW_ID, homeInstance: 'friend.example' },
    });
    expect(res.statusCode).toBe(404);
    expect(remoteRowCount()).toBe(0);
  });

  it('the row name never comes from the request body', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: NEW_ID, homeInstance: 'friend.example', username: 'mallory' },
    });
    expect(res.statusCode).toBe(201);
    expect(userByHomeId(NEW_ID)?.username).toBe(`${NEW_ID}@friend.example`);
  });

  it('a row that already exists still resolves when its home is not reachable', async () => {
    testDb.insert(schema.users).values({
      id: 'stub-kai', username: 'kai@friend.example', displayName: 'Kai',
      passwordHash: '!federation-replicated', homeInstance: 'friend.example', homeUserId: NEW_ID, createdAt: Date.now(),
    }).run();
    testDb.update(schema.federationPeers).set({ status: 'unreachable' }).run();
    const res = await app.inject({
      method: 'POST', url: '/api/dm',
      payload: { homeUserId: NEW_ID, homeInstance: 'friend.example' },
    });
    expect(res.statusCode).toBe(201);
    const ids = (res.json() as { members: MemberView[] }).members.map((m) => m.id);
    expect(ids).toContain('stub-kai');
  });
});
