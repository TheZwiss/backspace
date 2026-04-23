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

vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://local.example',
  buildFederationHeaders: () => ({}),
  generateHmacSecret: () => 'test-secret',
}));

// Mock sendCallRelay so tests can control relay-result per case.
const sendCallRelayMock = vi.fn();
vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    sendCallRelay: (...args: unknown[]) => sendCallRelayMock(...args),
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

function seedPeerLabel(origin: string, instanceName: string): void {
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

function seedLocalUser(id: string, homeUserId: string | null): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    passwordHash: 'test',
    homeUserId,
    homeInstance: null,
    createdAt: Date.now(),
  }).run();
}

async function importSUT() {
  // Late import so the module picks up the mocked dependencies.
  return await import('./events.js');
}

async function importManager() {
  const mod = await import('./handler.js');
  return mod.connectionManager;
}

type FedCallEntry = import('./handler.js').FederatedCallEntry;

function makeFedCall(partial: Partial<FedCallEntry> = {}): FedCallEntry {
  return {
    dmChannelId: 'dm-1',
    federatedId: `fed-${Math.random().toString(36).slice(2, 10)}`,
    callerId: 'caller-user',
    callerHomeUserId: 'caller@pi',
    federatedCallHost: 'https://pi.example',
    livekitUrl: 'wss://pi.example/lk',
    tokens: new Map([['acceptor@vm', 'token']]),
    ringedUserIds: ['acceptor-user'],
    state: 'ringing',
    startedAt: Date.now(),
    ...partial,
  };
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  seedPeerLabel('https://pi.example', 'Pi-Instance');
  seedLocalUser('acceptor-user', 'acceptor@vm');
  seedLocalUser('caller-user', 'caller@pi');
  sendCallRelayMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleDmCallAccept Path-2 relay failure', () => {
  it('emits dm_call_undeliverable { phase:"accept", terminal:true } and clears the fedCall when the relay fails', async () => {
    const { handleDmCallAcceptForTest } = await importSUT();
    const connectionManager = await importManager();

    const fedCall = makeFedCall();
    connectionManager.createFederatedCall(fedCall);
    const sendToUsersSpy = vi.spyOn(connectionManager, 'sendToFederatedCallUsers');
    sendCallRelayMock.mockResolvedValue({ ok: false, reason: 'peer_transient_failure', error: 'timeout' });

    await handleDmCallAcceptForTest(
      { federatedCallId: fedCall.federatedId },
      fedCall.ringedUserIds[0]!,
      {} as never,
    );

    expect(connectionManager.getFederatedCall(fedCall.federatedId)).toBeUndefined();
    const calls = sendToUsersSpy.mock.calls.filter(([, ev]) =>
      (ev as { type: string }).type === 'dm_call_undeliverable',
    );
    expect(calls).toHaveLength(1);
    const undeliverable = calls[0]![1] as { phase: string; terminal: boolean; failures: unknown[] };
    expect(undeliverable.phase).toBe('accept');
    expect(undeliverable.terminal).toBe(true);
    expect(undeliverable.failures).toHaveLength(1);
  });

  it('does not emit undeliverable on relay success', async () => {
    const { handleDmCallAcceptForTest } = await importSUT();
    const connectionManager = await importManager();

    const fedCall = makeFedCall();
    connectionManager.createFederatedCall(fedCall);
    const sendToUsersSpy = vi.spyOn(connectionManager, 'sendToFederatedCallUsers');
    sendCallRelayMock.mockResolvedValue({ ok: true });

    await handleDmCallAcceptForTest(
      { federatedCallId: fedCall.federatedId },
      fedCall.ringedUserIds[0]!,
      {} as never,
    );

    const undelivCalls = sendToUsersSpy.mock.calls.filter(([, ev]) =>
      (ev as { type: string }).type === 'dm_call_undeliverable',
    );
    expect(undelivCalls).toHaveLength(0);
    expect(connectionManager.getFederatedCall(fedCall.federatedId)?.state).toBe('active');
    connectionManager.clearFederatedCall(fedCall.federatedId);
  });
});
