import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('../utils/federationAuth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationAuth.js')>(
    '../utils/federationAuth.js',
  );
  return {
    ...actual,
    getOurOrigin: () => 'https://local.example',
    buildFederationHeaders: () => ({}),
  };
});

// Mock the REAL token factory (`routes/livekit.js`) so each minted token is
// traceable back to the identity it was minted for. A LiveKit token is a bearer
// credential; these tests assert exactly which identities' credentials leave
// this instance and to whom.
vi.mock('../routes/livekit.js', () => ({
  generateFederatedCallToken: (roomName: string, homeUserId: string) =>
    Promise.resolve(`token:${roomName}:${homeUserId}`),
}));

type CallRelayEvent = {
  messageId: string;
  federatedId?: string;
  call?: {
    tokens?: Record<string, string>;
    participants?: Array<{ homeUserId: string; homeInstance: string }>;
    caller?: { homeUserId: string; homeInstance: string };
  };
};
type RelayArgs = [string, CallRelayEvent[]];
const sendCallRelayMock = vi.fn();
vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>(
    '../utils/federationOutbox.js',
  );
  return {
    ...actual,
    sendCallRelay: (...args: RelayArgs) => sendCallRelayMock(...args),
  };
});

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      domain: 'local.example',
      livekit: {
        url: 'wss://local.example/livekit',
        apiKey: 'key',
        apiSecret: 'secret',
      },
    },
  };
});

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedActivePeer(origin: string, instanceName: string): void {
  testDb.insert(schema.federationPeers).values({
    id: `peer-${origin}`,
    origin,
    hmacSecret: 'secret',
    status: 'active',
    instanceName,
    lastSyncedAt: 0,
    createdAt: Date.now(),
  }).run();
}

function seedLocalUser(id: string, opts: { homeUserId?: string | null; homeInstance?: string | null } = {}): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    passwordHash: 'test',
    homeUserId: opts.homeUserId ?? null,
    homeInstance: opts.homeInstance ?? null,
    createdAt: Date.now(),
  }).run();
}

function seedDmChannel(id: string, federatedId: string, ownerId: string | null): void {
  testDb.insert(schema.dmChannels).values({
    id,
    ownerId,
    federatedId,
    createdAt: Date.now(),
  }).run();
}

function seedDmMember(dmChannelId: string, userId: string): void {
  testDb.insert(schema.dmMembers).values({ dmChannelId, userId }).run();
}

async function importSUT() {
  return await import('./events.js');
}

async function importManager() {
  return (await import('./handler.js')).connectionManager;
}

/** All origins `sendCallRelay` was invoked with, in call order. */
function relayedOrigins(): string[] {
  return sendCallRelayMock.mock.calls.map(([origin]) => origin as string);
}

/** The single relay event sent to `origin`, or undefined if none was sent. */
function relayTo(origin: string): CallRelayEvent | undefined {
  const call = sendCallRelayMock.mock.calls.find(([o]) => o === origin);
  return call ? (call[1] as CallRelayEvent[])[0] : undefined;
}

let sqlite: Database.Database;

describe('sendFederatedCallStart — LiveKit token scoping', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);

    const cm = await importManager();
    for (const [fedId] of cm.getAllFederatedCalls()) cm.clearFederatedCall(fedId);
    sendCallRelayMock.mockReset();
    sendCallRelayMock.mockResolvedValue({ ok: true, undeliverable: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('local-only DM call sends no relay at all, even with active peers present', async () => {
    // Both members are homed here. No peer hosts a participant, so no peer has
    // any business learning the call exists — let alone holding a room token.
    seedLocalUser('alice', { homeUserId: null, homeInstance: null });
    seedLocalUser('dave', { homeUserId: null, homeInstance: null });
    seedDmChannel('dm-local', 'fed-local-only', null);
    seedDmMember('dm-local', 'alice');
    seedDmMember('dm-local', 'dave');
    seedActivePeer('https://orbit.example', 'Orbit');
    seedActivePeer('https://nova.example', 'Nova');

    const cm = await importManager();
    cm.createDmRoom('dm-local', 'alice');

    const { sendFederatedCallStartForTest } = await importSUT();
    await sendFederatedCallStartForTest('dm-local', 'alice', 'Alice');

    expect(relayedOrigins()).toEqual([]);
  });

  it('gives each peer tokens only for the members it hosts, and nothing to uninvolved peers', async () => {
    // Group DM: caller alice (local), dave (local), bob (orbit), carol (nova).
    // ghost.example is an active peer hosting nobody in this DM.
    seedLocalUser('alice', { homeUserId: null, homeInstance: null });
    seedLocalUser('dave', { homeUserId: null, homeInstance: null });
    seedLocalUser('bob-stub', { homeUserId: 'bob-home', homeInstance: 'https://orbit.example' });
    seedLocalUser('carol-stub', { homeUserId: 'carol-home', homeInstance: 'https://nova.example' });
    seedDmChannel('dm-group', 'fed-group', 'alice');
    seedDmMember('dm-group', 'alice');
    seedDmMember('dm-group', 'dave');
    seedDmMember('dm-group', 'bob-stub');
    seedDmMember('dm-group', 'carol-stub');
    seedActivePeer('https://orbit.example', 'Orbit');
    seedActivePeer('https://nova.example', 'Nova');
    seedActivePeer('https://ghost.example', 'Ghost');

    const cm = await importManager();
    cm.createDmRoom('dm-group', 'alice');

    const { sendFederatedCallStartForTest } = await importSUT();
    await sendFederatedCallStartForTest('dm-group', 'alice', 'Alice');

    // Only the two participant-hosting peers were contacted.
    expect(relayedOrigins().sort()).toEqual([
      'https://nova.example',
      'https://orbit.example',
    ]);
    expect(relayTo('https://ghost.example')).toBeUndefined();

    const orbit = relayTo('https://orbit.example');
    const nova = relayTo('https://nova.example');
    expect(orbit).toBeDefined();
    expect(nova).toBeDefined();

    // Each peer receives exactly one token: the one for the member it hosts.
    expect(orbit!.call?.tokens).toEqual({
      'bob-home': 'token:fed-group:bob-home',
    });
    expect(nova!.call?.tokens).toEqual({
      'carol-home': 'token:fed-group:carol-home',
    });

    // Neither peer receives a credential for a local member or the caller.
    for (const relay of [orbit!, nova!]) {
      const keys = Object.keys(relay.call?.tokens ?? {});
      expect(keys).not.toContain('alice');
      expect(keys).not.toContain('dave');
    }

    // The non-secret roster still names every participant, so Path B identity
    // matching on the recipient keeps working.
    expect(
      (nova!.call?.participants ?? []).map(p => p.homeUserId).sort(),
    ).toEqual(['alice', 'bob-home', 'carol-home', 'dave']);
  });

  it('mints a token for every remote member of a single peer', async () => {
    // Two members homed on the same peer: that peer legitimately needs both.
    seedLocalUser('alice', { homeUserId: null, homeInstance: null });
    seedLocalUser('bob-stub', { homeUserId: 'bob-home', homeInstance: 'https://orbit.example' });
    seedLocalUser('erin-stub', { homeUserId: 'erin-home', homeInstance: 'https://orbit.example' });
    seedDmChannel('dm-same-peer', 'fed-same-peer', 'alice');
    seedDmMember('dm-same-peer', 'alice');
    seedDmMember('dm-same-peer', 'bob-stub');
    seedDmMember('dm-same-peer', 'erin-stub');
    seedActivePeer('https://orbit.example', 'Orbit');

    const cm = await importManager();
    cm.createDmRoom('dm-same-peer', 'alice');

    const { sendFederatedCallStartForTest } = await importSUT();
    await sendFederatedCallStartForTest('dm-same-peer', 'alice', 'Alice');

    expect(relayedOrigins()).toEqual(['https://orbit.example']);
    expect(relayTo('https://orbit.example')!.call?.tokens).toEqual({
      'bob-home': 'token:fed-same-peer:bob-home',
      'erin-home': 'token:fed-same-peer:erin-home',
    });
  });
});
