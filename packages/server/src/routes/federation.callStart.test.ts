import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type WebSocket from 'ws';
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

describe('processRelayEvents → processDmCallStartEvent', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);

    const cm = await importManager();
    for (const [fedId] of cm.getAllFederatedCalls()) cm.clearFederatedCall(fedId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('Path B: zero matches → undeliverable, no FederatedCallEntry created', async () => {
    // Arrange: no local DM, no local user matching the participant list
    const { processRelayEvents } = await importSUT();
    const cm = await importManager();

    const federatedId = 'fed-call-pathB-empty';
    const event = {
      eventType: 'dm_call_start' as const,
      messageId: 'msg-1',
      encryptionVersion: 0 as const,
      timestamp: Date.now(),
      federatedId,
      call: {
        livekitUrl: 'wss://lk.example',
        tokens: { 'caller-home': 'tok-c', 'unknown-home': 'tok-u' },
        caller: {
          homeUserId: 'caller-home',
          homeInstance: 'https://remote.example',
          displayName: 'Caller',
        },
        participants: [
          { homeUserId: 'caller-home', homeInstance: 'https://remote.example', displayName: 'Caller' },
          { homeUserId: 'unknown-home', homeInstance: 'https://remote.example', displayName: 'Unknown' },
        ],
      },
    };

    // Act
    const result = await processRelayEvents([event], 'https://remote.example', 'https://remote.example', testDb);

    // Assert
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.undeliverable).toEqual([
      { messageId: 'msg-1', reason: 'no_recipient' },
    ]);
    expect(cm.getFederatedCall(federatedId)).toBeUndefined();
  });

  it('Path A: zero connected local members → undeliverable, no entry created', async () => {
    const { processRelayEvents } = await importSUT();
    const cm = await importManager();

    // Arrange: local DM channel with federated_id matches; two local members, both offline
    const federatedId = 'fed-call-pathA-all-offline';
    const dmChannelId = 'dm-1';
    seedUser('bob-local');
    seedUser('alice-local');
    testDb.insert(schema.dmChannels).values({
      id: dmChannelId,
      ownerId: null,
      federatedId,
      createdAt: Date.now(),
    }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId, userId: 'bob-local' },
      { dmChannelId, userId: 'alice-local' },
    ]).run();

    // Stub: both users offline (zero WS connections)
    vi.spyOn(cm, 'getUserConnections').mockImplementation(() => new Set());

    const event = {
      eventType: 'dm_call_start' as const,
      messageId: 'msg-2',
      encryptionVersion: 0 as const,
      timestamp: Date.now(),
      federatedId,
      call: {
        livekitUrl: 'wss://lk.example',
        tokens: {
          'caller-home': 'tok-c',
          'bob-local': 'tok-b',
          'alice-local': 'tok-a',
        },
        caller: {
          homeUserId: 'caller-home',
          homeInstance: 'https://remote.example',
          displayName: 'Caller',
        },
        participants: [],
      },
    };

    const sendToUserSpy = vi.spyOn(cm, 'sendToUser');

    const result = await processRelayEvents([event], 'https://remote.example', 'https://remote.example', testDb);

    expect(result.accepted).toEqual([]);
    expect(result.undeliverable).toEqual([{ messageId: 'msg-2', reason: 'no_recipient' }]);
    // No dm_call_incoming dispatched to anyone
    expect(sendToUserSpy).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'dm_call_incoming' }),
    );
    // No FederatedCallEntry
    expect(cm.getFederatedCall(federatedId)).toBeUndefined();
  });

  it('Path A: mixed online + offline rings only connected members', async () => {
    const { processRelayEvents } = await importSUT();
    const cm = await importManager();

    const federatedId = 'fed-call-pathA-mixed';
    const dmChannelId = 'dm-2';
    seedUser('bob-local');
    seedUser('carol-local');
    testDb.insert(schema.dmChannels).values({
      id: dmChannelId,
      ownerId: null,
      federatedId,
      createdAt: Date.now(),
    }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId, userId: 'bob-local' },
      { dmChannelId, userId: 'carol-local' },
    ]).run();

    // Bob online, Carol offline
    vi.spyOn(cm, 'getUserConnections').mockImplementation((uid: string) =>
      uid === 'bob-local' ? new Set(['fakews' as unknown as WebSocket]) : new Set(),
    );

    const sendToUserSpy = vi.spyOn(cm, 'sendToUser');

    const event = {
      eventType: 'dm_call_start' as const,
      messageId: 'msg-3',
      encryptionVersion: 0 as const,
      timestamp: Date.now(),
      federatedId,
      call: {
        livekitUrl: 'wss://lk.example',
        tokens: {
          'caller-home': 'tok-c',
          'bob-local': 'tok-b',
          'carol-local': 'tok-car',
        },
        caller: {
          homeUserId: 'caller-home',
          homeInstance: 'https://remote.example',
          displayName: 'Caller',
        },
        participants: [],
      },
    };

    const result = await processRelayEvents([event], 'https://remote.example', 'https://remote.example', testDb);

    expect(result.accepted).toEqual(['msg-3']);
    expect(result.undeliverable).toEqual([]);

    // Bob was rung
    expect(sendToUserSpy).toHaveBeenCalledWith(
      'bob-local',
      expect.objectContaining({ type: 'dm_call_incoming', livekitToken: 'tok-b' }),
    );
    // Carol was NOT rung (offline)
    expect(sendToUserSpy).not.toHaveBeenCalledWith(
      'carol-local',
      expect.anything(),
    );

    const entry = cm.getFederatedCall(federatedId);
    expect(entry).toBeDefined();
    expect(entry!.ringedUserIds).toEqual(['bob-local']);
  });
});
