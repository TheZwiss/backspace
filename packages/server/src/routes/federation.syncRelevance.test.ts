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
import { signRequest } from '../utils/federationAuth.js';
import { randomUUID } from 'node:crypto';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level mutable state. Each beforeEach reassigns sqlite/testDb;
// the getDb getter in the mock closes over the current binding.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const PEER_ORIGIN = 'https://orbit.test';
const PEER_SECRET = 'a'.repeat(64);
const PEER_ID = 'peer-orbit';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
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

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { _resetLookupRateBuckets, federationRoutes } = await import('./federation.js');
  _resetLookupRateBuckets();
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

function signedHeaders(body: string): Record<string, string> {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const sig = signRequest(body, PEER_SECRET, timestamp, nonce);
  return {
    'X-Federation-Origin': PEER_ORIGIN,
    'X-Federation-Timestamp': String(timestamp),
    'X-Federation-Nonce': nonce,
    'X-Federation-Signature': `sha256=${sig}`,
    'Content-Type': 'application/json',
  };
}

function seedPeer(): void {
  testDb.insert(schema.federationPeers).values({
    id: PEER_ID,
    origin: PEER_ORIGIN,               // 'https://orbit.test' from the copied harness
    hmacSecret: PEER_SECRET,           // 'a'.repeat(64) from the copied harness
    status: 'active',
    createdAt: Date.now(),
  }).run();
}

function seedUser(row: Partial<typeof schema.users.$inferInsert> & { id: string; username: string }): void {
  testDb.insert(schema.users).values({
    passwordHash: '!federation-replicated',
    createdAt: 1,
    ...row,
  } as typeof schema.users.$inferInsert).run();
}

/** channel + members + one locally-created message + its mutation-log row */
function seedDmWithMessage(channelId: string, memberIds: string[], authorId: string, ts: number): void {
  testDb.insert(schema.dmChannels).values({
    id: channelId, federatedId: `fed-${channelId}`, createdAt: 1,
  }).run();
  for (const uid of memberIds) {
    testDb.insert(schema.dmMembers).values({ dmChannelId: channelId, userId: uid, closed: 0 }).run();
  }
  testDb.insert(schema.dmMessages).values({
    id: `msg-${channelId}`, dmChannelId: channelId, userId: authorId, content: 'hi', createdAt: ts,
  }).run();
  testDb.insert(schema.federationMutationLog).values({
    id: `ml-${channelId}`, entityId: `msg-${channelId}`, contextId: channelId,
    contextType: 'dm', mutationType: 'create', mutatedAt: ts,
  }).run();
}

function seedFriendMutation(id: string, ts: number, from: { homeUserId: string; homeInstance: string }, to: { homeUserId: string; homeInstance: string }): void {
  testDb.insert(schema.federationMutationLog).values({
    id, entityId: `fr-${id}`, contextId: `fr-ctx-${id}`,
    contextType: 'friend', mutationType: 'friend_add', mutatedAt: ts,
    payload: JSON.stringify({
      friendship: {
        from, to,
        fromProfile: { username: 'x' }, toProfile: { username: 'y' },
        createdAt: ts,
      },
    }),
  }).run();
}

async function syncPull(app: FastifyInstance, body: object) {
  const bodyStr = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/api/federation/sync',
    headers: signedHeaders(bodyStr),
    payload: bodyStr,
  });
}

describe('POST /api/federation/sync — DM relevance filter', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedPeer();
    seedUser({ id: 'alice', username: 'alice', passwordHash: 'real-hash', homeInstance: null });
    seedUser({ id: 'bob', username: 'bob@orbit.test', homeInstance: 'orbit.test', homeUserId: 'bob-home' });
    seedUser({ id: 'carol', username: 'carol@orbit.test', homeInstance: 'orbit.test', homeUserId: 'carol-home', federationHomeOrphaned: 1 });
    seedUser({ id: 'dave', username: 'dave@elsewhere.test', homeInstance: 'elsewhere.test', homeUserId: 'dave-home' });
    seedDmWithMessage('ch-live', ['alice', 'bob'], 'alice', 100);      // live orbit member → offered
    seedDmWithMessage('ch-detached', ['alice', 'carol'], 'alice', 110); // only detached orbit member → excluded
    seedDmWithMessage('ch-other', ['alice', 'dave'], 'alice', 120);     // no orbit member at all → excluded
    app = await buildApp();
  });

  it('only returns events for channels with a live, non-detached member homed at the requester', async () => {
    const res = await syncPull(app, { sinceTimestamp: 0 });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const channelIds = body.events.map((e: { dmChannelId: string }) => e.dmChannelId);
    expect(channelIds).toEqual(['ch-live']);
  });

  it('returns empty DM sync for a reset peer (all requester-domain rows detached)', async () => {
    // Flip bob to detached too — simulates the post-reset state.
    testDb.update(schema.users).set({ federationHomeOrphaned: 1 }).where(eq(schema.users.id, 'bob')).run();
    const res = await syncPull(app, { sinceTimestamp: 0 });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.events).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it('excludes a tombstoned requester-domain member from qualifying a channel', async () => {
    testDb.update(schema.users).set({ isDeleted: 1 }).where(eq(schema.users.id, 'bob')).run();
    const res = await syncPull(app, { sinceTimestamp: 0 });
    const body = JSON.parse(res.body);
    expect(body.events).toEqual([]);
  });

  it('federatedId filter on an excluded channel returns empty (inherits relevance check)', async () => {
    const res = await syncPull(app, { sinceTimestamp: 0, federatedId: 'fed-ch-other' });
    const body = JSON.parse(res.body);
    expect(body.events).toEqual([]);
  });

  it('matches home_instance stored as a full URL too (normalization)', async () => {
    testDb.update(schema.users).set({ homeInstance: 'https://orbit.test' }).where(eq(schema.users.id, 'bob')).run();
    const res = await syncPull(app, { sinceTimestamp: 0 });
    const body = JSON.parse(res.body);
    expect(body.events.map((e: { dmChannelId: string }) => e.dmChannelId)).toEqual(['ch-live']);
  });
});

describe('POST /api/federation/sync — friend relevance filter', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedPeer();
    app = await buildApp();
  });

  it('returns friend events involving the requester domain; filters unrelated ones', async () => {
    seedFriendMutation('f1', 100,
      { homeUserId: 'a1', homeInstance: 'https://home.test' },
      { homeUserId: 'b1', homeInstance: 'https://orbit.test' });   // involves requester → returned
    seedFriendMutation('f2', 110,
      { homeUserId: 'a2', homeInstance: 'https://home.test' },
      { homeUserId: 'c1', homeInstance: 'https://elsewhere.test' }); // unrelated → filtered
    const res = await syncPull(app, { sinceTimestamp: 0, contextType: 'friend' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].friendship.to.homeUserId).toBe('b1');
    // Checkpoint advances past the FILTERED row too (pre-filter pagination).
    expect(body.checkpoint).toBe(110);
  });

  it('does not qualify an event via a side that resolves to a DETACHED local row', async () => {
    seedUser({ id: 'stub-dead', username: 'dead@orbit.test', homeInstance: 'orbit.test', homeUserId: 'dead-home', federationHomeOrphaned: 1 });
    seedFriendMutation('f3', 100,
      { homeUserId: 'a1', homeInstance: 'https://home.test' },
      { homeUserId: 'dead-home', homeInstance: 'https://orbit.test' });
    const res = await syncPull(app, { sinceTimestamp: 0, contextType: 'friend' });
    const body = JSON.parse(res.body);
    expect(body.events).toEqual([]);
    expect(body.checkpoint).toBe(100); // still advances
  });

  it('qualifies a requester-domain side with no local row (receiver guard is the backstop)', async () => {
    seedFriendMutation('f4', 100,
      { homeUserId: 'a1', homeInstance: 'https://home.test' },
      { homeUserId: 'unknown-home', homeInstance: 'https://orbit.test' });
    const res = await syncPull(app, { sinceTimestamp: 0, contextType: 'friend' });
    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(1);
  });
});
