import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
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
 * #347: a message replayed through `/api/federation/sync` carries the same
 * `message.mentions` list as the live relay, so a peer that catches up by
 * sync-pull stores mentions under its own ids too.
 *
 * Two instances in one process, as in `federation.syncReactionCoords.test.ts`:
 * HOME serves the sync, ORBIT pulls it and replays it through
 * `processRelayEvents`. alice (native on HOME) wrote a message on HOME that
 * mentions bob (native on ORBIT) by HOME's row for him, and herself.
 */

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

interface Instance {
  origin: string;
  sqlite: Database.Database;
  db: TestDb;
}

const HOME_ORIGIN = 'https://home.test';
const ORBIT_ORIGIN = 'https://orbit.test';
const SECRET = 'c'.repeat(64);
const FEDERATED_ID = 'fed-alice-bob';

let current: Instance;

vi.mock('../db/index.js', () => ({
  getDb: () => current.db,
  getRawDb: () => current.sqlite,
  schema,
}));

// The sync endpoint names a native author's instance by `config.domain`.
vi.mock('../config.js', async (importActual) => {
  const actual = await importActual<typeof import('../config.js')>();
  return { ...actual, config: { ...actual.config, domain: 'home.test' } };
});

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
  db.insert(schema.instanceSettings).values({ id: 1, federationRelayEnabled: 1, updatedAt: Date.now() }).run();
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
  db.insert(schema.dmChannels).values({ id: channelId, federatedId: FEDERATED_ID, createdAt: 1 }).run();
  for (const userId of memberIds) {
    db.insert(schema.dmMembers).values({ dmChannelId: channelId, userId, closed: 0 }).run();
  }
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

async function orbitPullsFromHome(): Promise<FederationRelayEvent[]> {
  current = home;
  const body = JSON.stringify({ sinceTimestamp: 0, limit: 100 });
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

async function orbitReplays(events: FederationRelayEvent[]) {
  current = orbit;
  const { processRelayEvents } = await import('./federation.js');
  return processRelayEvents(events, HOME_ORIGIN, HOME_ORIGIN, orbit.db);
}

function orbitCopy(): string | null | undefined {
  return orbit.db
    .select({ content: schema.dmMessages.content })
    .from(schema.dmMessages)
    .where(eq(schema.dmMessages.sourceMessageId, 'msg-on-home'))
    .get()?.content;
}

describe('POST /api/federation/sync — replayed messages carry their mention list (#347)', () => {
  beforeEach(async () => {
    home = makeInstance(HOME_ORIGIN, ORBIT_ORIGIN);
    seedUser(home.db, { id: 'alice', username: 'alice', passwordHash: 'real-hash', homeInstance: null });
    seedUser(home.db, { id: 'bob-on-home', username: 'bob@orbit.test', homeInstance: 'orbit.test', homeUserId: 'bob' });
    seedDm(home.db, 'ch-home', ['alice', 'bob-on-home']);
    home.db.insert(schema.dmMessages).values({
      id: 'msg-on-home', dmChannelId: 'ch-home', userId: 'alice',
      content: 'ping <@bob-on-home> from <@alice>', createdAt: 100,
    }).run();
    home.db.insert(schema.federationMutationLog).values({
      id: 'ml-create', entityId: 'msg-on-home', contextId: 'ch-home', contextType: 'dm',
      mutationType: 'create', mutatedAt: 100, payload: null,
    }).run();

    orbit = makeInstance(ORBIT_ORIGIN, HOME_ORIGIN);
    seedUser(orbit.db, { id: 'bob', username: 'bob', passwordHash: 'real-hash', homeInstance: null });
    seedUser(orbit.db, { id: 'alice-on-orbit', username: 'alice@home.test', homeInstance: 'home.test', homeUserId: 'alice' });
    seedDm(orbit.db, 'ch-orbit', ['bob', 'alice-on-orbit']);

    current = home;
    app = await buildApp();
  });

  it('the replayed create names each mentioned id with its federated identity', async () => {
    const create = (await orbitPullsFromHome()).find(e => e.eventType === 'create');
    expect(create?.message?.mentions).toEqual([
      { id: 'bob-on-home', homeUserId: 'bob', homeInstance: 'orbit.test' },
      { id: 'alice', homeUserId: 'alice', homeInstance: HOME_ORIGIN },
    ]);
  });

  it('the receiver stores the replayed message with its own ids', async () => {
    const result = await orbitReplays(await orbitPullsFromHome());
    expect(result.rejected).toEqual([]);
    expect(orbitCopy()).toBe('ping <@bob> from <@alice-on-orbit>');
  });
});
