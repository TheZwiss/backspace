import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { FederationRelayEvent, FederationSyncResponse } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signRequest } from '../utils/federationAuth.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * #318: a reaction replayed through `/api/federation/sync` must name its
 * message in shared coordinates (`reaction.messageId` + `messageHomeInstance`),
 * exactly as the live relay does, or the receiver cannot find the message when
 * the sender only holds a relayed copy of it.
 *
 * Two instances in one process: HOME serves the sync, ORBIT pulls it and feeds
 * the events to `processRelayEvents` the way `syncPeerMutationLog` does. Each
 * has its own in-memory database; `getDb` and `getOurOrigin` follow whichever
 * instance is "running".
 *
 * The message is bob's, native on ORBIT (`msg-on-orbit`). HOME holds a relayed
 * copy of it under its own id (`copy-on-home`). alice, native on HOME, reacts to
 * that copy, so HOME's mutation log names the message by `copy-on-home`, an id
 * ORBIT has never seen.
 */

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

interface Instance {
  origin: string;
  sqlite: Database.Database;
  db: TestDb;
}

const HOME_ORIGIN = 'https://home.test';
const ORBIT_ORIGIN = 'https://orbit.test';
const SECRET = 'b'.repeat(64);

let current: Instance;

vi.mock('../db/index.js', () => ({
  getDb: () => current.db,
  getRawDb: () => current.sqlite,
  schema,
}));

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => current.origin };
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

function makeInstance(origin: string, peerOrigin: string): Instance {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  db.insert(schema.federationPeers).values({
    id: `peer-${peerOrigin}`,
    origin: peerOrigin,
    hmacSecret: SECRET,
    status: 'active',
    createdAt: Date.now(),
  }).run();
  return { origin, sqlite, db };
}

function seedUser(db: TestDb, row: Partial<typeof schema.users.$inferInsert> & { id: string; username: string }): void {
  db.insert(schema.users).values({
    passwordHash: '!federation-replicated',
    createdAt: 1,
    ...row,
  } as typeof schema.users.$inferInsert).run();
}

function seedDm(db: TestDb, channelId: string, memberIds: string[]): void {
  db.insert(schema.dmChannels).values({ id: channelId, federatedId: 'fed-alice-bob', createdAt: 1 }).run();
  for (const userId of memberIds) {
    db.insert(schema.dmMembers).values({ dmChannelId: channelId, userId, closed: 0 }).run();
  }
}

/** The mutation-log row HOME's reaction handler writes (ws/events.ts). */
function logReaction(db: TestDb, mutationType: 'reaction_add' | 'reaction_remove', mutatedAt: number): void {
  db.insert(schema.federationMutationLog).values({
    id: `ml-${mutationType}-${mutatedAt}`,
    entityId: 'copy-on-home',
    contextId: 'ch-home',
    contextType: 'dm',
    mutationType,
    mutatedAt,
    payload: JSON.stringify({
      userId: 'alice',
      homeUserId: 'alice',
      homeInstance: HOME_ORIGIN,
      emoji: '🎉',
      ...(mutationType === 'reaction_add' ? { createdAt: mutatedAt } : {}),
    }),
  }).run();
}

let home: Instance;
let orbit: Instance;
let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  const { _resetLookupRateBuckets, federationRoutes } = await import('./federation.js');
  _resetLookupRateBuckets();
  await server.register(federationRoutes);
  await server.ready();
  return server;
}

/** ORBIT pulls HOME's mutation log through HOME's real sync endpoint. */
async function orbitPullsFromHome(sinceTimestamp: number): Promise<FederationRelayEvent[]> {
  current = home;
  const body = JSON.stringify({ sinceTimestamp, limit: 100 });
  const timestamp = Date.now();
  const nonce = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/api/federation/sync',
    headers: {
      'X-Federation-Origin': ORBIT_ORIGIN,
      'X-Federation-Timestamp': String(timestamp),
      'X-Federation-Nonce': nonce,
      'X-Federation-Signature': `sha256=${signRequest(body, SECRET, timestamp, nonce)}`,
      'Content-Type': 'application/json',
    },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as FederationSyncResponse).events;
}

/** ORBIT replays pulled events exactly as `syncPeerMutationLog` does. */
async function orbitReplays(events: FederationRelayEvent[]) {
  current = orbit;
  const { processRelayEvents } = await import('./federation.js');
  return processRelayEvents(events, HOME_ORIGIN, HOME_ORIGIN, orbit.db);
}

function orbitReactors(): string[] {
  return orbit.db
    .select({ userId: schema.dmReactions.userId })
    .from(schema.dmReactions)
    .where(and(eq(schema.dmReactions.dmMessageId, 'msg-on-orbit'), eq(schema.dmReactions.emoji, '🎉')))
    .all()
    .map(r => r.userId);
}

describe('POST /api/federation/sync — replayed reactions carry shared message coordinates (#318)', () => {
  beforeEach(async () => {
    home = makeInstance(HOME_ORIGIN, ORBIT_ORIGIN);
    seedUser(home.db, { id: 'alice', username: 'alice', passwordHash: 'real-hash', homeInstance: null });
    seedUser(home.db, { id: 'bob-on-home', username: 'bob@orbit.test', homeInstance: 'orbit.test', homeUserId: 'bob' });
    seedDm(home.db, 'ch-home', ['alice', 'bob-on-home']);
    home.db.insert(schema.dmMessages).values({
      id: 'copy-on-home', dmChannelId: 'ch-home', userId: 'bob-on-home', content: 'question from bob',
      createdAt: 100, sourceInstance: ORBIT_ORIGIN, sourceMessageId: 'msg-on-orbit',
    }).run();

    orbit = makeInstance(ORBIT_ORIGIN, HOME_ORIGIN);
    seedUser(orbit.db, { id: 'bob', username: 'bob', passwordHash: 'real-hash', homeInstance: null });
    seedUser(orbit.db, { id: 'alice-on-orbit', username: 'alice@home.test', homeInstance: 'home.test', homeUserId: 'alice' });
    seedDm(orbit.db, 'ch-orbit', ['bob', 'alice-on-orbit']);
    orbit.db.insert(schema.dmMessages).values({
      id: 'msg-on-orbit', dmChannelId: 'ch-orbit', userId: 'bob', content: 'question from bob', createdAt: 100,
    }).run();

    current = home;
    app = await buildApp();
  });

  it('names the reacted message by its id and origin on the instance that created it', async () => {
    logReaction(home.db, 'reaction_add', 200);
    const events = (await orbitPullsFromHome(0)).filter(e => e.eventType === 'reaction_add');
    expect(events).toHaveLength(1);
    expect(events[0]!.reaction?.messageId).toBe('msg-on-orbit');
    expect(events[0]!.reaction?.messageHomeInstance).toBe(ORBIT_ORIGIN);
  });

  it('a replayed reaction_add lands on the message on the receiver', async () => {
    logReaction(home.db, 'reaction_add', 200);
    const result = await orbitReplays(await orbitPullsFromHome(0));
    expect(result.rejected).toEqual([]);
    expect(orbitReactors()).toEqual(['alice-on-orbit']);
  });

  it('a replayed reaction_remove removes it from the message on the receiver', async () => {
    logReaction(home.db, 'reaction_add', 200);
    await orbitReplays(await orbitPullsFromHome(0));
    expect(orbitReactors()).toEqual(['alice-on-orbit']);

    logReaction(home.db, 'reaction_remove', 300);
    const removes = (await orbitPullsFromHome(200)).filter(e => e.eventType === 'reaction_remove');
    expect(removes).toHaveLength(1);
    expect(removes[0]!.reaction?.messageId).toBe('msg-on-orbit');
    expect(removes[0]!.reaction?.messageHomeInstance).toBe(ORBIT_ORIGIN);

    const result = await orbitReplays(removes);
    expect(result.rejected).toEqual([]);
    expect(orbitReactors()).toEqual([]);
  });
});
