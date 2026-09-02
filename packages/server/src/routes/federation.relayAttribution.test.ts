import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { buildFederationHeaders } from '../utils/federationAuth.js';
import type { FederationRelayEvent } from '@backspace/shared';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
const sendToUser = vi.fn();

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser,
    sendToAdmins: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    forceDisconnectUser: vi.fn(),
    lateBindFederatedCall: vi.fn(),
    getDmRoomMeta: vi.fn(() => undefined),
    setDmRoomMeta: vi.fn(),
    getAllOnlineUserIds: () => [],
  },
}));
vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => { req.userId = 'admin-user'; },
  requireAdmin: async () => { /* federation S2S routes are HMAC-authenticated */ },
}));
vi.mock('../utils/federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(async () => undefined),
  onPeerDeactivated: vi.fn(async () => undefined),
}));
vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => OUR_ORIGIN };
});

const OUR_ORIGIN = 'https://home.test';
const HOME_DOMAIN = 'home.test';
/** The peer whose HMAC secret every request in this file is signed with. */
const SIGNING_PEER = 'https://orbit.test';
const SIGNING_SECRET = 'orbit-shared-secret-0123456789abcdef';
/** A third instance the signing peer has no authority to speak for. */
const OTHER_PEER = 'https://vault.test';
const OTHER_SECRET = 'vault-shared-secret-0123456789abcdef';

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

function seedInstanceSettings(): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceName: 'Home Backspace',
    instanceId: 'home-epoch-0000',
    autoAcceptPeering: 1,
    registrationOpen: 1,
    updatedAt: Date.now(),
  } as typeof schema.instanceSettings.$inferInsert).run();
}

function seedActivePeer(id: string, origin: string, secret: string): void {
  testDb.insert(schema.federationPeers).values({
    id,
    origin,
    hmacSecret: secret,
    status: 'active',
    createdAt: Date.now(),
  }).run();
}

/** A native user of THIS instance (homeInstance NULL — we are their identity authority). */
function seedLocalUser(id: string, username: string): void {
  testDb.insert(schema.users).values({
    id,
    username,
    passwordHash: 'x',
    status: 'online',
    isAdmin: 0,
    createdAt: Date.now(),
  } as typeof schema.users.$inferInsert).run();
}

/** The local user's own record that they hold a federated account on `origin`. */
function seedRegistryEntry(userId: string, origin: string): void {
  testDb.insert(schema.userFederationRegistry).values({
    userId,
    origin,
    label: 'Orbit',
    username: `${userId}@${HOME_DOMAIN}`,
    remoteUserId: 'remote-id',
    status: 'connected',
    addedAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { federationRoutes } = await import('./federation.js');
  await app.register(federationRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  seedInstanceSettings();
  seedActivePeer('peer-orbit', SIGNING_PEER, SIGNING_SECRET);
  seedActivePeer('peer-vault', OTHER_PEER, OTHER_SECRET);
  sendToUser.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: the relay batch's claimed sourceInstance must be the peer that
// actually signed the request.
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/federation/relay — sourceInstance is bound to the authenticated peer', () => {
  let app: FastifyInstance;

  beforeEach(async () => { app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  async function inject(claimedSource: string): Promise<number> {
    const body = JSON.stringify({ version: 1, sourceInstance: claimedSource, events: [] });
    const headers = buildFederationHeaders(body, SIGNING_SECRET, SIGNING_PEER);
    const res = await app.inject({ method: 'POST', url: '/api/federation/relay', headers, payload: body });
    return res.statusCode;
  }

  // Positive control: proves the harness can produce an accepted relay at all,
  // so the 403 assertions below cannot pass for the wrong reason.
  it('accepts a batch whose sourceInstance matches the signing peer', async () => {
    expect(await inject(SIGNING_PEER)).toBe(200);
  });

  it('accepts a bare-domain sourceInstance for the signing peer (normalization)', async () => {
    expect(await inject('orbit.test')).toBe(200);
  });

  it('rejects a batch claiming to originate from a different instance', async () => {
    expect(await inject(OTHER_PEER)).toBe(403);
  });

  it('rejects a batch claiming to originate from this instance', async () => {
    expect(await inject(OUR_ORIGIN)).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: a peer may only assert an author homed HERE when the local user has
// an established federated presence on that peer.
// ─────────────────────────────────────────────────────────────────────────────

function makeCreateEvent(messageId: string): FederationRelayEvent {
  return {
    eventType: 'create',
    contextType: 'dm',
    messageId,
    encryptionVersion: 0,
    timestamp: 1_700_000_000_000,
    participants: [
      { homeUserId: 'alice-local', homeInstance: HOME_DOMAIN, profile: { username: 'alice' } },
      { homeUserId: 'bob-local', homeInstance: HOME_DOMAIN, profile: { username: 'bob' } },
    ],
    message: {
      userId: 'alice-local',
      homeUserId: 'alice-local',
      homeInstance: HOME_DOMAIN,
      content: 'transfer the funds',
      replyToId: null,
      editedAt: null,
      createdAt: 1_700_000_000_000,
    },
  };
}

function countRows(): { channels: number; messages: number } {
  return {
    channels: testDb.select().from(schema.dmChannels).all().length,
    messages: testDb.select().from(schema.dmMessages).all().length,
  };
}

describe('processRelayEvents — homeward attribution requires peer involvement', () => {
  beforeEach(() => {
    seedLocalUser('alice-local', 'alice');
    seedLocalUser('bob-local', 'bob');
  });

  // Positive control for every "nothing was written" assertion below.
  it('accepts a homeward relay from a peer the acting user is connected to', async () => {
    seedRegistryEntry('alice-local', SIGNING_PEER);
    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([makeCreateEvent('m-legit')], SIGNING_PEER, SIGNING_PEER, testDb);

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual(['m-legit']);
    expect(countRows()).toEqual({ channels: 1, messages: 1 });
  });

  it('accepts a homeward relay when the peer is listed in the user replicatedInstances', async () => {
    testDb.update(schema.users)
      .set({ replicatedInstances: JSON.stringify([{ origin: SIGNING_PEER, username: 'alice@home.test' }]) })
      .where(eq(schema.users.id, 'alice-local'))
      .run();
    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([makeCreateEvent('m-legit-2')], SIGNING_PEER, SIGNING_PEER, testDb);

    expect(result.rejected).toEqual([]);
    expect(countRows()).toEqual({ channels: 1, messages: 1 });
  });

  it('rejects a homeward relay from a peer the acting user has never connected to', async () => {
    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([makeCreateEvent('m-forged')], OTHER_PEER, OTHER_PEER, testDb);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ messageId: 'm-forged', reason: 'attribution_mismatch' }]);
    expect(countRows()).toEqual({ channels: 0, messages: 0 });
  });

  it('rejects a homeward relay for a user connected to a DIFFERENT peer', async () => {
    // alice is connected to orbit; vault signs the batch and claims her.
    seedRegistryEntry('alice-local', SIGNING_PEER);
    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([makeCreateEvent('m-forged-2')], OTHER_PEER, OTHER_PEER, testDb);

    expect(result.rejected).toEqual([{ messageId: 'm-forged-2', reason: 'attribution_mismatch' }]);
    expect(countRows()).toEqual({ channels: 0, messages: 0 });
  });
});

describe('processRelayEvents — refuses a batch whose source is not the authenticated peer', () => {
  it('rejects every event when sourceInstance and peerOrigin disagree', async () => {
    seedLocalUser('alice-local', 'alice');
    seedLocalUser('bob-local', 'bob');
    seedRegistryEntry('alice-local', SIGNING_PEER);

    const { processRelayEvents } = await import('./federation.js');
    // The batch would be accepted if it were genuinely signed by orbit; here
    // vault signed it while claiming orbit as the source.
    const result = await processRelayEvents([makeCreateEvent('m-spoof')], SIGNING_PEER, OTHER_PEER, testDb);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ messageId: 'm-spoof', reason: 'source_peer_mismatch' }]);
    expect(countRows()).toEqual({ channels: 0, messages: 0 });
  });
});
