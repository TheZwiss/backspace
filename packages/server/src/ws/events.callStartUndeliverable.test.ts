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
    generateFederatedCallToken: () => Promise.resolve('fake-token'),
  };
});

// Mock sendCallRelay so the test controls relay results per peer. The
// implementation captures the messageId each call was made with so tests
// can return { undeliverable: [messageId] } dynamically.
type RelayArgs = [string, Array<{ messageId: string }>];
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

// Mock config to claim LiveKit is configured.
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

let sqlite: Database.Database;

describe('sendFederatedCallStart — undeliverable reclassification (#18)', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);

    const cm = await importManager();
    // Reset federatedCalls + rooms between tests.
    for (const [fedId] of cm.getAllFederatedCalls()) cm.clearFederatedCall(fedId);
    sendCallRelayMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('single targeted peer returns undeliverable → terminal dm_call_undeliverable, room destroyed', async () => {
    // 1-on-1 DM: Alice local, Bob remote on orbit.
    const federatedId = 'fed-1on1';
    seedLocalUser('alice', { homeUserId: null, homeInstance: null });
    seedLocalUser('bob-stub', { homeUserId: 'bob-home', homeInstance: 'https://orbit.example' });
    seedDmChannel('dm-1', federatedId, null);
    seedDmMember('dm-1', 'alice');
    seedDmMember('dm-1', 'bob-stub');
    seedActivePeer('https://orbit.example', 'Orbit');

    const cm = await importManager();
    cm.createDmRoom('dm-1', 'alice');  // caller's local ring room (mirrors real flow)

    // Capture the messageId sendFederatedCallStart generates, return it as undeliverable.
    sendCallRelayMock.mockImplementation(async (_origin: string, events: Array<{ messageId: string }>) => {
      return { ok: true, undeliverable: [events[0]!.messageId] };
    });

    const sendToUserSpy = vi.spyOn(cm, 'sendToUser');
    const destroyRoomSpy = vi.spyOn(cm, 'destroyRoom');

    const { sendFederatedCallStartForTest } = await importSUT();
    await sendFederatedCallStartForTest('dm-1', 'alice', 'Alice');

    // The caller (Alice) got a terminal dm_call_undeliverable with reason='no_recipient'.
    const undelivCalls = sendToUserSpy.mock.calls.filter(([, ev]) =>
      (ev as { type: string }).type === 'dm_call_undeliverable',
    );
    expect(undelivCalls).toHaveLength(1);
    expect(undelivCalls[0]![0]).toBe('alice');

    const ev = undelivCalls[0]![1] as {
      terminal: boolean;
      phase: string;
      failures: Array<{ reason: string; peerLabel?: string; peerOrigin?: string }>;
    };
    expect(ev.terminal).toBe(true);
    expect(ev.phase).toBe('start');
    expect(ev.failures).toHaveLength(1);
    expect(ev.failures[0]!.reason).toBe('no_recipient');
    expect(ev.failures[0]!.peerOrigin).toBe('https://orbit.example');
    expect(ev.failures[0]!.peerLabel).toBe('Orbit');

    // Room was destroyed.
    expect(destroyRoomSpy).toHaveBeenCalledWith('dm-1');
  });

  it('group DM mixed delivered + undeliverable → non-terminal, failures lists only the undeliverable peer', async () => {
    // Group DM: caller + one member on orbit (delivers) + one member on nova (undeliverable).
    const federatedId = 'fed-group';
    seedLocalUser('alice', { homeUserId: null, homeInstance: null });
    seedLocalUser('bob-stub', { homeUserId: 'bob-home', homeInstance: 'https://orbit.example' });
    seedLocalUser('carol-stub', { homeUserId: 'carol-home', homeInstance: 'https://nova.example' });
    seedDmChannel('dm-group', federatedId, 'alice');  // group DM: ownerId non-null
    seedDmMember('dm-group', 'alice');
    seedDmMember('dm-group', 'bob-stub');
    seedDmMember('dm-group', 'carol-stub');
    seedActivePeer('https://orbit.example', 'Orbit');
    seedActivePeer('https://nova.example', 'Nova');

    const cm = await importManager();
    cm.createDmRoom('dm-group', 'alice');

    // Orbit delivers (empty undeliverable), Nova returns messageId in undeliverable.
    sendCallRelayMock.mockImplementation(async (origin: string, events: Array<{ messageId: string }>) => {
      if (origin === 'https://nova.example') {
        return { ok: true, undeliverable: [events[0]!.messageId] };
      }
      return { ok: true, undeliverable: [] };
    });

    const sendToUserSpy = vi.spyOn(cm, 'sendToUser');
    const destroyRoomSpy = vi.spyOn(cm, 'destroyRoom');

    const { sendFederatedCallStartForTest } = await importSUT();
    await sendFederatedCallStartForTest('dm-group', 'alice', 'Alice');

    // Room NOT destroyed (orbit delivered).
    expect(destroyRoomSpy).not.toHaveBeenCalledWith('dm-group');

    const undelivCalls = sendToUserSpy.mock.calls.filter(([uid, ev]) =>
      uid === 'alice' && (ev as { type: string }).type === 'dm_call_undeliverable',
    );
    expect(undelivCalls).toHaveLength(1);

    const ev = undelivCalls[0]![1] as {
      terminal: boolean;
      failures: Array<{ reason: string; peerOrigin?: string }>;
    };
    expect(ev.terminal).toBe(false);
    expect(ev.failures).toHaveLength(1);
    expect(ev.failures[0]!.reason).toBe('no_recipient');
    expect(ev.failures[0]!.peerOrigin).toBe('https://nova.example');
  });

  it('single targeted peer delivers (empty undeliverable) → no undeliverable event', async () => {
    const federatedId = 'fed-happy';
    seedLocalUser('alice', {});
    seedLocalUser('bob-stub', { homeUserId: 'bob-home', homeInstance: 'https://orbit.example' });
    seedDmChannel('dm-happy', federatedId, null);
    seedDmMember('dm-happy', 'alice');
    seedDmMember('dm-happy', 'bob-stub');
    seedActivePeer('https://orbit.example', 'Orbit');

    const cm = await importManager();
    cm.createDmRoom('dm-happy', 'alice');

    sendCallRelayMock.mockResolvedValue({ ok: true, undeliverable: [] });

    const sendToUserSpy = vi.spyOn(cm, 'sendToUser');
    const { sendFederatedCallStartForTest } = await importSUT();
    await sendFederatedCallStartForTest('dm-happy', 'alice', 'Alice');

    const undelivCalls = sendToUserSpy.mock.calls.filter(([, ev]) =>
      (ev as { type: string }).type === 'dm_call_undeliverable',
    );
    expect(undelivCalls).toHaveLength(0);
  });
});
