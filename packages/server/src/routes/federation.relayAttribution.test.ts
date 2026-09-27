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
      // alice's partner lives on the signing peer: a 1-on-1 is only relayed
      // between the instances its two people live on.
      { homeUserId: 'bob-orbit', homeInstance: 'orbit.test', profile: { username: 'bob' } },
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

  // A homeward relay with no proof on file is refused as `attribution_unproven`:
  // the proof is written by the user's own client and can land after the relay
  // it explains. Nothing is written either way; only the reason tells the
  // sender that a later retry can succeed.
  it('refuses, as unproven, a homeward relay from a peer the acting user has never connected to', async () => {
    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([makeCreateEvent('m-forged')], OTHER_PEER, OTHER_PEER, testDb);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ messageId: 'm-forged', reason: 'attribution_unproven' }]);
    expect(countRows()).toEqual({ channels: 0, messages: 0 });
  });

  it('refuses, as unproven, a homeward relay for a user connected to a DIFFERENT peer', async () => {
    // alice is connected to orbit; vault signs the batch and claims her.
    seedRegistryEntry('alice-local', SIGNING_PEER);
    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([makeCreateEvent('m-forged-2')], OTHER_PEER, OTHER_PEER, testDb);

    expect(result.rejected).toEqual([{ messageId: 'm-forged-2', reason: 'attribution_unproven' }]);
    expect(countRows()).toEqual({ channels: 0, messages: 0 });
  });

  it('accepts the same relay on retry once the proof has arrived', async () => {
    const { processRelayEvents } = await import('./federation.js');
    const first = await processRelayEvents([makeCreateEvent('m-late-proof')], SIGNING_PEER, SIGNING_PEER, testDb);
    expect(first.rejected).toEqual([{ messageId: 'm-late-proof', reason: 'attribution_unproven' }]);

    seedRegistryEntry('alice-local', SIGNING_PEER);
    const retry = await processRelayEvents([makeCreateEvent('m-late-proof')], SIGNING_PEER, SIGNING_PEER, testDb);
    expect(retry.rejected).toEqual([]);
    expect(retry.accepted).toEqual(['m-late-proof']);
    expect(countRows()).toEqual({ channels: 1, messages: 1 });
  });

  it('still refuses an author homed on a THIRD instance as a terminal mismatch', async () => {
    const event = makeCreateEvent('m-third');
    event.message = { ...event.message!, homeUserId: 'mallory', userId: 'mallory', homeInstance: 'vault.test' };
    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents([event], SIGNING_PEER, SIGNING_PEER, testDb);

    expect(result.rejected).toEqual([{ messageId: 'm-third', reason: 'attribution_mismatch' }]);
  });
});

describe('processRelayEvents — friend_remove needs only one attributable side', () => {
  beforeEach(() => {
    seedLocalUser('alice-local', 'alice');
  });

  function removeEvent(messageId: string, from: { homeUserId: string; homeInstance: string }): FederationRelayEvent {
    return {
      eventType: 'friend_remove',
      contextType: 'friend',
      messageId,
      encryptionVersion: 0,
      timestamp: 1_700_000_000_000,
      friendship: {
        from,
        to: { homeUserId: 'mallory', homeInstance: 'vault.test' },
        createdAt: 1_700_000_000_000,
      },
    };
  }

  it('is unproven when one side is a local user whose proof has not arrived', async () => {
    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents(
      [removeEvent('fr-unproven', { homeUserId: 'alice-local', homeInstance: HOME_DOMAIN })],
      SIGNING_PEER, SIGNING_PEER, testDb,
    );
    expect(result.rejected).toEqual([{ messageId: 'fr-unproven', reason: 'attribution_unproven' }]);
  });

  it('is a mismatch when neither side can ever be attributed to the peer', async () => {
    const { processRelayEvents } = await import('./federation.js');
    const result = await processRelayEvents(
      [removeEvent('fr-mismatch', { homeUserId: 'ghost', homeInstance: HOME_DOMAIN })],
      SIGNING_PEER, SIGNING_PEER, testDb,
    );
    expect(result.rejected).toEqual([{ messageId: 'fr-mismatch', reason: 'attribution_mismatch' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: `attribution_unproven` is only put on the wire for a sender that says
// it retries it. Every other sender gets the v1 answer, `attribution_mismatch`,
// so an older instance keeps the behaviour it was built for.
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/federation/relay — the unproven reason is negotiated per request', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    seedLocalUser('alice-local', 'alice');
    app = await buildApp();
  });
  afterEach(async () => { await app.close(); });

  async function relay(messageId: string, extra: Record<string, unknown>): Promise<{ status: number; rejected: Array<{ messageId: string; reason: string }> }> {
    const body = JSON.stringify({ version: 1, sourceInstance: SIGNING_PEER, ...extra, events: [makeCreateEvent(messageId)] });
    const headers = buildFederationHeaders(body, SIGNING_SECRET, SIGNING_PEER);
    const res = await app.inject({ method: 'POST', url: '/api/federation/relay', headers, payload: body });
    const parsed = res.json() as { rejected: Array<{ messageId: string; reason: string }> };
    return { status: res.statusCode, rejected: parsed.rejected };
  }

  it('answers attribution_unproven to a sender that lists the capability', async () => {
    const res = await relay('m-cap', { capabilities: ['attribution_unproven'] });
    expect(res.status).toBe(200);
    expect(res.rejected).toEqual([{ messageId: 'm-cap', reason: 'attribution_unproven' }]);
  });

  it('answers attribution_mismatch to a sender that does not list it', async () => {
    const res = await relay('m-nocap', {});
    expect(res.status).toBe(200);
    expect(res.rejected).toEqual([{ messageId: 'm-nocap', reason: 'attribution_mismatch' }]);
  });

  it('ignores a capabilities field that is not a list of strings', async () => {
    const res = await relay('m-badcap', { capabilities: 'attribution_unproven' });
    expect(res.status).toBe(200);
    expect(res.rejected).toEqual([{ messageId: 'm-badcap', reason: 'attribution_mismatch' }]);
  });
});

describe('processRelayEvents — refuses a batch whose source is not the authenticated peer', () => {
  it('rejects every event when sourceInstance and peerOrigin disagree', async () => {
    seedLocalUser('alice-local', 'alice');
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
