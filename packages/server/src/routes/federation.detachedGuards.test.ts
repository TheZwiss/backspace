import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signRequest } from '../utils/federationAuth.js';
import type { FederationRelayEvent } from '@backspace/shared';

setWorkerId(9);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const PEER_ORIGIN = 'https://orbit.test';
const PEER_DOMAIN = 'orbit.test';
const PEER_SECRET = 'a'.repeat(64);

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    evictFederatedCallsForHost: vi.fn(),
    federatedCalls: new Map(),
    isUserOnline: vi.fn(),
    lateBindFederatedCall: vi.fn(),
    forceDisconnectUser: vi.fn(),
  },
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

function seedActivePeer(): void {
  testDb.insert(schema.federationPeers).values({
    id: 'peer-1',
    origin: PEER_ORIGIN,
    hmacSecret: PEER_SECRET,
    status: 'active',
    nonceSupported: 1,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    consecutiveFailures: 0,
    consecutiveAuthFailures: 0,
  } as typeof schema.federationPeers.$inferInsert).run();
}

const DETACHED_ID = 'detached-1';
const DETACHED_HOME_UID = 'old-home-uid';

// A REAL federated account whose home domain (orbit.test) was reset. It has been
// detached (federationHomeOrphaned = 1): sovereign local account, never re-bindable
// to the reset domain's new incarnation.
function seedDetachedAccount(): void {
  testDb.insert(schema.users).values({
    id: DETACHED_ID,
    username: 'alice@orbit.test',
    displayName: 'Alice',
    passwordHash: '$2b$10$abcdefghijklmnopqrstuv', // real bcrypt-like hash
    status: 'offline',
    isAdmin: 0,
    isDeleted: 0,
    homeInstance: PEER_DOMAIN,
    homeUserId: DETACHED_HOME_UID,
    federationHomeOrphaned: 1,
    profileUpdatedAt: 1000,
    createdAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('./federation.js');
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

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  seedActivePeer();
  seedDetachedAccount();
});

describe('S2S identity delete — detached account guard', () => {
  it('skips a detached account (idempotent 200, row intact)', async () => {
    const app = await buildApp();
    const body = JSON.stringify({
      homeUserId: DETACHED_HOME_UID,
      homeInstance: PEER_DOMAIN,
      mode: 'full',
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/federation/identity',
      headers: signedHeaders(body),
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    const row = testDb.select().from(schema.users).where(eq(schema.users.id, DETACHED_ID)).get();
    expect(row?.isDeleted).toBe(0); // NOT deleted — detached account is sovereign
    await app.close();
  });
});

describe('S2S profile_update — detached account guard', () => {
  it('skips a detached account (acked, profile unchanged)', async () => {
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'profile_update',
      contextType: 'profile',
      messageId: 'm-hijack',
      encryptionVersion: 0,
      timestamp: Date.now(),
      profileUpdate: {
        homeUserId: DETACHED_HOME_UID,
        homeInstance: PEER_DOMAIN,
        profileUpdatedAt: 999999, // newer than stored 1000 — would apply if not guarded
        username: 'alice',
        displayName: 'Hijacked',
        avatar: null,
        banner: null,
        accentColor: null,
        avatarColor: null,
        bio: null,
      },
    };
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processProfileUpdateEvent(event, PEER_DOMAIN, testDb, accepted, rejected);

    // Acked (not rejected) — the sender considers this identity theirs to update.
    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['m-hijack']);

    // But the detached row's profile is untouched.
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, DETACHED_ID)).get();
    expect(row?.displayName).toBe('Alice');
    expect(row?.profileUpdatedAt).toBe(1000);
  });
});
