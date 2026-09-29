import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { FederationSyncRequest, FederationSyncResponse } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signRequest } from '../utils/federationAuth.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * #255, serving side of `POST /api/federation/sync`: HOME serves its mutation
 * log to ORBIT.
 * - Keyset pagination: rows sharing a millisecond across a page boundary are
 *   each served exactly once (before, the next page asked for `> checkpoint`
 *   and skipped the rest of that millisecond).
 * - `group_metadata_update` is served (before, it was logged and never served).
 * - `file_rejected` is served only to the instance the message came from.
 * - A reaction row is served only when the reaction's current state agrees.
 * - Relevance compares hosts the way attribution does, so a member stored with
 *   a port or a scheme still makes the channel the requester's.
 */

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const HOME_ORIGIN = 'https://home.test';
const ORBIT_ORIGIN = 'https://orbit.test';
const SECRET = 'a'.repeat(64);

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => HOME_ORIGIN };
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

let app: FastifyInstance;

async function pull(request: Partial<FederationSyncRequest>, signer = ORBIT_ORIGIN): Promise<FederationSyncResponse> {
  const body = JSON.stringify({ sinceTimestamp: 0, limit: 100, ...request });
  const timestamp = Date.now();
  const nonce = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/api/federation/sync',
    headers: {
      'X-Federation-Origin': signer,
      'X-Federation-Timestamp': String(timestamp),
      'X-Federation-Nonce': nonce,
      'X-Federation-Signature': `sha256=${signRequest(body, SECRET, timestamp, nonce)}`,
      'Content-Type': 'application/json',
    },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as FederationSyncResponse;
}

function seedUser(row: Partial<typeof schema.users.$inferInsert> & { id: string; username: string }): void {
  testDb.insert(schema.users).values({ passwordHash: 'x', createdAt: 1, ...row } as typeof schema.users.$inferInsert).run();
}

function log(row: { id: string; entityId: string; mutationType: string; mutatedAt: number; payload?: string; contextId?: string; contextType?: string }): void {
  testDb.insert(schema.federationMutationLog).values({
    id: row.id,
    entityId: row.entityId,
    contextId: row.contextId ?? 'ch-group',
    contextType: row.contextType ?? 'dm',
    mutationType: row.mutationType,
    mutatedAt: row.mutatedAt,
    payload: row.payload ?? null,
  }).run();
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  for (const origin of [ORBIT_ORIGIN, 'https://third.test']) {
    testDb.insert(schema.federationPeers).values({
      id: `peer-${origin}`, origin, hmacSecret: SECRET, status: 'active', createdAt: 1,
    }).run();
  }
  seedUser({ id: 'alice', username: 'alice', homeInstance: null });
  // Stored with a scheme and a port: still orbit's host.
  seedUser({ id: 'bob-on-home', username: 'bob@orbit.test', homeInstance: 'https://orbit.test:8443', homeUserId: 'bob' });
  seedUser({ id: 'carol-on-home', username: 'carol@third.test', homeInstance: 'third.test', homeUserId: 'carol' });
  testDb.insert(schema.dmChannels).values({ id: 'ch-group', federatedId: 'fed-group', ownerId: 'alice', createdAt: 1 }).run();
  for (const userId of ['alice', 'bob-on-home', 'carol-on-home']) {
    testDb.insert(schema.dmMembers).values({ dmChannelId: 'ch-group', userId }).run();
  }

  const { _resetLookupRateBuckets, federationRoutes } = await import('./federation.js');
  _resetLookupRateBuckets();
  app = Fastify({ logger: false });
  await app.register(federationRoutes);
  await app.ready();
});

describe('keyset pagination', () => {
  it('serves 150 rows that share one millisecond exactly once across pages', async () => {
    for (let i = 0; i < 150; i++) {
      const id = `4000000000000${String(i).padStart(5, '0')}`;
      log({ id, entityId: `read_state:${i}`, mutationType: 'read_state_update', mutatedAt: 5_000,
        payload: JSON.stringify({ user: { homeUserId: 'alice', homeInstance: HOME_ORIGIN }, messageRef: { sourceInstance: HOME_ORIGIN, sourceMessageId: 'm' } }) });
    }
    const seen: string[] = [];
    let request: Partial<FederationSyncRequest> = { sinceTimestamp: 0 };
    for (let pages = 0; pages < 5; pages++) {
      const page = await pull(request);
      seen.push(...page.events.map(e => e.messageId));
      if (!page.hasMore) break;
      expect(page.checkpointId).toBeDefined();
      request = { sinceTimestamp: page.checkpoint, afterId: page.checkpointId };
    }
    expect(seen).toHaveLength(150);
    expect(new Set(seen).size).toBe(150);
  });

  it('returns the checkpointId of the last row read, and the friend context pages on rows read', async () => {
    log({ id: '4000000000000000001', entityId: 'f1', mutationType: 'friend_remove', mutatedAt: 10, contextType: 'friend', contextId: 'x',
      payload: JSON.stringify({ friendship: { from: { homeUserId: 'z', homeInstance: 'elsewhere.test' }, to: { homeUserId: 'y', homeInstance: 'elsewhere.test' } } }) });
    const page = await pull({ contextType: 'friend', limit: 1 });
    // Not orbit's, so not served, but the cursor still moves past it.
    expect(page.events).toEqual([]);
    expect(page).toMatchObject({ hasMore: true, checkpoint: 10, checkpointId: '4000000000000000001' });
  });
});

describe('what is served', () => {
  it('serves group_metadata_update with the conversation key', async () => {
    const metadata = { name: 'Team', icon: null, metadataUpdatedAt: 300, actor: { homeUserId: 'alice', homeInstance: HOME_ORIGIN } };
    log({ id: '4000000000000000010', entityId: 'group_metadata:fed-group:300', mutationType: 'group_metadata_update', mutatedAt: 300, payload: JSON.stringify(metadata) });
    const page = await pull({});
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ eventType: 'group_metadata_update', federatedId: 'fed-group', metadata });
  });

  it('serves file_rejected only to the instance the message came from', async () => {
    testDb.insert(schema.dmMessages).values({
      id: 'copy-of-bobs', dmChannelId: 'ch-group', userId: 'bob-on-home', content: 'big', createdAt: 100,
      sourceInstance: ORBIT_ORIGIN, sourceMessageId: 'bobs-msg',
    }).run();
    log({ id: '4000000000000000020', entityId: 'bobs-msg', mutationType: 'file_rejected', mutatedAt: 400,
      payload: JSON.stringify({ attachmentId: 'a', sourceFilename: 'f.png', rejectionReason: 'size_limit_exceeded', rejectionLimit: 1,
        affectedUserIds: ['alice'], affectedUsers: [{ homeUserId: 'alice', homeInstance: HOME_ORIGIN }] }) });

    const toOrbit = await pull({});
    expect(toOrbit.events).toHaveLength(1);
    expect(toOrbit.events[0]).toMatchObject({
      eventType: 'file_rejected', messageId: 'bobs-msg', affectedUsers: [{ homeUserId: 'alice', homeInstance: HOME_ORIGIN }],
    });

    const toThird = await pull({}, 'https://third.test');
    expect(toThird.events).toEqual([]);
  });

  it('serves a reaction row only when the reaction is still in that state', async () => {
    testDb.insert(schema.dmMessages).values({ id: 'm1', dmChannelId: 'ch-group', userId: 'alice', content: 'hi', createdAt: 100 }).run();
    const reaction = JSON.stringify({ userId: 'alice', homeUserId: 'alice', homeInstance: HOME_ORIGIN, emoji: '👍' });
    log({ id: '4000000000000000031', entityId: 'm1', mutationType: 'reaction_add', mutatedAt: 500, payload: reaction });
    log({ id: '4000000000000000032', entityId: 'm1', mutationType: 'reaction_remove', mutatedAt: 600, payload: reaction });

    // Removed now: only the remove is served.
    expect((await pull({})).events.map(e => e.eventType)).toEqual(['reaction_remove']);

    testDb.insert(schema.dmReactions).values({ id: 'r1', dmMessageId: 'm1', userId: 'alice', emoji: '👍', createdAt: 700 }).run();
    log({ id: '4000000000000000033', entityId: 'm1', mutationType: 'reaction_add', mutatedAt: 700, payload: reaction });
    expect((await pull({})).events.map(e => `${e.eventType}@${e.timestamp}`)).toEqual(['reaction_add@500', 'reaction_add@700']);
  });

  it('does not serve a conversation none of whose members is homed at the requester', async () => {
    testDb.update(schema.users).set({ homeInstance: 'elsewhere.test' }).run();
    testDb.insert(schema.dmMessages).values({ id: 'm1', dmChannelId: 'ch-group', userId: 'alice', content: 'hi', createdAt: 100 }).run();
    log({ id: '4000000000000000040', entityId: 'm1', mutationType: 'create', mutatedAt: 100 });
    expect((await pull({})).events).toEqual([]);
  });
});
