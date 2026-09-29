import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type WebSocket from 'ws';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { FederationRelayEvent } from '@backspace/shared';

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

async function importSUT() {
  return await import('./federation.js');
}

async function importManager() {
  const mod = await import('../ws/handler.js');
  return mod.connectionManager;
}

let sqlite: Database.Database;

/** Insert a minimal native user row so dmMembers FK constraints pass. */
function seedUser(id: string): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    passwordHash: '!test',
    createdAt: Date.now(),
  }).run();
}

/**
 * A dm_call_start names each token's holder by federated identity
 * (`call.memberTokens`), and the receiver hands a token only to the local
 * user that identity resolves to. A home user id alone is unique only on the
 * instance that issued it, so it never picks the holder by itself.
 */

function seedReplica(id: string, homeUserId: string, homeInstance: string): void {
  testDb.insert(schema.users).values({
    id, username: `${homeUserId}@${homeInstance}`, passwordHash: '!federation-replicated',
    homeUserId, homeInstance, createdAt: Date.now(),
  }).run();
}

function seedDm(dmChannelId: string, federatedId: string, members: string[]): void {
  testDb.insert(schema.dmChannels).values({ id: dmChannelId, ownerId: 'bob', federatedId, createdAt: Date.now() }).run();
  testDb.insert(schema.dmMembers).values(members.map(userId => ({ dmChannelId, userId }))).run();
}

function callStart(federatedId: string, call: Partial<NonNullable<FederationRelayEvent['call']>>): FederationRelayEvent {
  return {
    eventType: 'dm_call_start',
    messageId: `msg-${federatedId}`,
    encryptionVersion: 0,
    timestamp: Date.now(),
    federatedId,
    call: {
      livekitUrl: 'wss://lk.example',
      tokens: {},
      caller: { homeUserId: 'caller-home', homeInstance: 'https://remote.example', displayName: 'Caller' },
      participants: [],
      ...call,
    },
  };
}

describe('dm_call_start: tokens go to the identity they were minted for', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    const cm = await importManager();
    for (const [fedId] of cm.getAllFederatedCalls()) cm.clearFederatedCall(fedId);
    // bob is native here. kai is homed on a third instance, where his id
    // happens to be 'bob' too; both are in the group and online.
    seedUser('bob');
    seedReplica('kai-here', 'bob', 'third.example');
    vi.spyOn(cm, 'getUserConnections').mockImplementation(() => new Set(['ws' as unknown as WebSocket]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('rings only the member the token names, with its home instance', async () => {
    const { processRelayEvents } = await importSUT();
    const cm = await importManager();
    const send = vi.spyOn(cm, 'sendToUser');
    seedDm('dm-a', 'fed-a', ['bob', 'kai-here']);

    await processRelayEvents([callStart('fed-a', {
      tokens: { bob: 'tok-bob' },
      memberTokens: [{ homeUserId: 'bob', homeInstance: 'https://local.example', token: 'tok-bob' }],
    })], 'https://remote.example', 'https://remote.example', testDb);

    expect(send).toHaveBeenCalledWith('bob', expect.objectContaining({ type: 'dm_call_incoming', livekitToken: 'tok-bob' }));
    expect(send).not.toHaveBeenCalledWith('kai-here', expect.anything());
    expect(cm.getFederatedCall('fed-a')?.tokens).toEqual(new Map([['bob', 'tok-bob']]));
  });

  it('a ready payload carries a member\'s own token only', async () => {
    const { processRelayEvents } = await importSUT();
    const cm = await importManager();
    seedDm('dm-r', 'fed-r', ['bob', 'kai-here']);
    await processRelayEvents([callStart('fed-r', {
      memberTokens: [{ homeUserId: 'bob', homeInstance: 'https://local.example', token: 'tok-bob' }],
    })], 'https://remote.example', 'https://remote.example', testDb);

    // The ready payload goes to the user's sockets; stop pretending every
    // user is connected so it reaches the one opened below.
    vi.mocked(cm.getUserConnections).mockRestore();
    const tokenInReady = (userId: string): string | undefined => {
      const ws = { readyState: 1, send: vi.fn() };
      cm.addConnection(userId, ws as never);
      cm.pushReadyPayload(userId);
      cm.removeConnection(ws as never);
      const ready = ws.send.mock.calls
        .map(([raw]) => JSON.parse(raw as string) as { type: string; activeCalls?: Array<{ federatedCallId?: string; livekitToken?: string }> })
        .find(e => e.type === 'ready');
      return ready?.activeCalls?.find(c => c.federatedCallId === 'fed-r')?.livekitToken;
    };
    expect(tokenInReady('bob')).toBe('tok-bob');
    expect(tokenInReady('kai-here')).toBeUndefined();
  });

  it('from an older sender (tokens by home user id only), holders are users homed here', async () => {
    const { processRelayEvents } = await importSUT();
    const cm = await importManager();
    const send = vi.spyOn(cm, 'sendToUser');
    seedDm('dm-b', 'fed-b', ['bob', 'kai-here']);

    await processRelayEvents([callStart('fed-b', { tokens: { bob: 'tok-bob' } })], 'https://remote.example', 'https://remote.example', testDb);

    expect(send).toHaveBeenCalledWith('bob', expect.objectContaining({ type: 'dm_call_incoming', livekitToken: 'tok-bob' }));
    expect(send).not.toHaveBeenCalledWith('kai-here', expect.anything());
  });

  it('never rings the caller\'s own row here, even when a token names it', async () => {
    const { processRelayEvents } = await importSUT();
    const cm = await importManager();
    const send = vi.spyOn(cm, 'sendToUser');
    seedReplica('caller-here', 'caller-home', 'remote.example');
    seedDm('dm-c', 'fed-c', ['caller-here', 'bob']);

    await processRelayEvents([callStart('fed-c', {
      memberTokens: [
        { homeUserId: 'caller-home', homeInstance: 'https://remote.example', token: 'tok-caller' },
        { homeUserId: 'bob', homeInstance: 'https://local.example', token: 'tok-bob' },
      ],
    })], 'https://remote.example', 'https://remote.example', testDb);

    expect(send).not.toHaveBeenCalledWith('caller-here', expect.anything());
    expect(send).toHaveBeenCalledWith('bob', expect.objectContaining({ livekitToken: 'tok-bob' }));
  });

  it('Path B (no local copy): rings the participant the token names', async () => {
    const { processRelayEvents } = await importSUT();
    const cm = await importManager();
    const send = vi.spyOn(cm, 'sendToUser');

    await processRelayEvents([callStart('fed-d', {
      tokens: { bob: 'tok-bob' },
      memberTokens: [{ homeUserId: 'bob', homeInstance: 'https://local.example', token: 'tok-bob' }],
      participants: [
        { homeUserId: 'caller-home', homeInstance: 'https://remote.example' },
        { homeUserId: 'bob', homeInstance: 'https://local.example' },
        { homeUserId: 'bob', homeInstance: 'https://third.example' },
      ],
    })], 'https://remote.example', 'https://remote.example', testDb);

    expect(send).toHaveBeenCalledWith('bob', expect.objectContaining({ type: 'dm_call_incoming', livekitToken: 'tok-bob' }));
    expect(send).not.toHaveBeenCalledWith('kai-here', expect.anything());
  });
});
