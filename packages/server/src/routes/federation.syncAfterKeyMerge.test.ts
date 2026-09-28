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
import { backfillOneOnOneKeys, oneOnOneKey } from '../utils/dmConversation.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/** A 1-on-1 row with one locally-created message and its mutation-log row. */
function seedOneOnOne(channelId: string, federatedId: string | null, memberIds: string[], messageId: string, ts: number): void {
  testDb.insert(schema.dmChannels).values({ id: channelId, federatedId, createdAt: ts }).run();
  for (const uid of memberIds) {
    testDb.insert(schema.dmMembers).values({ dmChannelId: channelId, userId: uid, closed: 0 }).run();
  }
  testDb.insert(schema.dmMessages).values({
    id: messageId, dmChannelId: channelId, userId: memberIds[0]!, content: messageId, createdAt: ts,
  }).run();
  testDb.insert(schema.federationMutationLog).values({
    id: `ml-${messageId}`, entityId: messageId, contextId: channelId,
    contextType: 'dm', mutationType: 'create', mutatedAt: ts,
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

/**
 * The startup key backfill merges an unkeyed 1-on-1 (made while relay was off)
 * into the row that holds its key. The merged-away row's mutation log and
 * pending outbox rows are keyed by its local channel id; they move with its
 * messages, so a peer that syncs from the log afterwards still gets them.
 */
describe('POST /api/federation/sync after the key backfill merged a 1-on-1', () => {
  let app: FastifyInstance;
  const key = oneOnOneKey({ id: 'alice', homeUserId: null }, { id: 'bob', homeUserId: 'bob-home' });

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedPeer();
    seedUser({ id: 'alice', username: 'alice', passwordHash: 'real-hash', homeInstance: null });
    seedUser({ id: 'bob', username: 'bob@orbit.test', homeInstance: 'orbit.test', homeUserId: 'bob-home' });
    // Relay off: written, logged, never delivered. Relay on: the peer's reply created the keyed copy.
    seedOneOnOne('ch-legacy', null, ['alice', 'bob'], 'msg-legacy', 100);
    seedOneOnOne('ch-relay', key, ['alice', 'bob'], 'msg-relay', 200);
    testDb.insert(schema.federationOutbox).values({
      id: 'ob-legacy', peerId: PEER_ID, contextId: 'ch-legacy', entityId: 'msg-legacy', contextType: 'dm',
      eventType: 'create', payload: '{}', nextRetryAt: 1, expiresAt: Date.now() + 86_400_000, createdAt: 100,
    }).run();
    backfillOneOnOneKeys(sqlite);
    app = await buildApp();
  });

  it('offers the merged-away row\'s messages under the surviving row', async () => {
    expect(testDb.select().from(schema.dmChannels).all().map(c => c.id)).toEqual(['ch-relay']);
    const res = await syncPull(app, { sinceTimestamp: 0 });
    expect(res.statusCode).toBe(200);
    const events = (JSON.parse(res.body) as { events: Array<{ messageId: string; dmChannelId: string }> }).events;
    expect(events.map(e => [e.messageId, e.dmChannelId])).toEqual([['msg-legacy', 'ch-relay'], ['msg-relay', 'ch-relay']]);
  });

  it('moves the merged-away row\'s pending outbox rows to the surviving row', () => {
    const outbox = testDb.select().from(schema.federationOutbox).where(eq(schema.federationOutbox.id, 'ob-legacy')).get();
    expect(outbox?.contextId).toBe('ch-relay');
  });
});
