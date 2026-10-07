// Receiver-side authority and storage tests for `processOwnershipTransferEvent`.
//
// The headline regression these tests pin down:
//
//   On a federated back-and-forth — A transfers ownership to B (federated), B
//   transfers it back to A — the second event was rejected at the receiver
//   with `unauthorized_source` because `dm_channels.ownerHomeInstance` was
//   written as a bare host (`orbit.ddns.net`) by
//   `transferGroupDmOwnership` (which copies `users.homeInstance`) while
//   `sourceInstance` always arrives as a full URL (`https://orbit.ddns.net`).
//   The strict-string-equality check fired, the event went back into the
//   outbox, and every retry hit the same mismatch — divergent ownership
//   between the two instances stuck until manual repair.
//
// The fix is two-fold:
//
//   1. Authority check normalizes both sides via `normalizeOriginForCompare`
//      so legacy bare-vs-full rows accept legitimate transfers.
//   2. Both the sender (`transferGroupDmOwnership`) and the receiver
//      (`processOwnershipTransferEvent`) canonicalize `ownerHomeInstance` to a
//      full origin URL on storage, so going forward the column is uniform.
//
// These tests cover the receiver — sender canonicalization is covered by the
// existing `dm.transfer.test.ts`.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { FederationRelayEvent } from '@backspace/shared';

setWorkerId(5);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../config.js', () => ({
  config: {
    domain: 'local.test',
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret-12345678901234567890123456789012',
    maxUploadSize: 100 * 1024 * 1024,
    registrationOpen: true,
    uploadDir: '/tmp/bs-fed-transfer-test',
  },
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
  },
}));

import { connectionManager } from '../ws/handler.js';

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

// Identities used by these tests. Owner is on `owner.test`, new owner is on
// `new.test`. The previous owner / source for the transfer event is the owner.
const OWNER_ORIGIN_FULL = 'https://owner.test';
const OWNER_ORIGIN_BARE = 'owner.test';
const NEW_OWNER_ORIGIN_FULL = 'https://new.test';
const NEW_OWNER_ORIGIN_BARE = 'new.test';
const FEDERATED_ID = 'fed-transfer-1';
const CHANNEL_ID = 'ch-transfer-local-1';

const OWNER_USER_ID = 'owner-user-stub';
const OWNER_HOME_USER_ID = 'home-owner-1';

const NEW_OWNER_USER_ID = 'new-owner-stub';
const NEW_OWNER_HOME_USER_ID = 'home-new-owner-1';

function seedUsers(): void {
  const now = Date.now();
  testDb.insert(schema.users).values({
    id: OWNER_USER_ID,
    username: 'owner@owner.test',
    displayName: 'owner',
    passwordHash: '!federation-replicated',
    status: 'offline',
    isAdmin: 0,
    homeInstance: OWNER_ORIGIN_BARE,
    homeUserId: OWNER_HOME_USER_ID,
    createdAt: now,
  }).run();

  testDb.insert(schema.users).values({
    id: NEW_OWNER_USER_ID,
    username: 'new@new.test',
    displayName: 'new owner',
    passwordHash: '!federation-replicated',
    status: 'offline',
    isAdmin: 0,
    homeInstance: NEW_OWNER_ORIGIN_BARE,
    homeUserId: NEW_OWNER_HOME_USER_ID,
    createdAt: now,
  }).run();
}

interface SeedOpts {
  ownerHomeInstance: string;
}

function seedChannel(opts: SeedOpts): void {
  const now = Date.now();
  testDb.insert(schema.dmChannels).values({
    id: CHANNEL_ID,
    federatedId: FEDERATED_ID,
    ownerId: OWNER_USER_ID,
    ownerHomeUserId: OWNER_HOME_USER_ID,
    ownerHomeInstance: opts.ownerHomeInstance,
    name: 'group',
    icon: null,
    metadataUpdatedAt: 1000,
    createdAt: now,
  }).run();
  testDb.insert(schema.dmMembers).values({ dmChannelId: CHANNEL_ID, userId: OWNER_USER_ID, closed: 0 }).run();
  testDb.insert(schema.dmMembers).values({ dmChannelId: CHANNEL_ID, userId: NEW_OWNER_USER_ID, closed: 0 }).run();
}

function buildTransferEvent(opts: {
  messageId?: string;
  newOwnerHomeInstance?: string;
  previousOwnerHomeInstance?: string;
} = {}): FederationRelayEvent {
  return {
    eventType: 'ownership_transfer',
    contextType: 'dm',
    messageId: opts.messageId ?? 'evt-transfer-1',
    federatedId: FEDERATED_ID,
    encryptionVersion: 0,
    timestamp: Date.now(),
    ownership: {
      newOwner: {
        homeUserId: NEW_OWNER_HOME_USER_ID,
        homeInstance: opts.newOwnerHomeInstance ?? NEW_OWNER_ORIGIN_FULL,
      },
      previousOwner: {
        homeUserId: OWNER_HOME_USER_ID,
        homeInstance: opts.previousOwnerHomeInstance ?? OWNER_ORIGIN_FULL,
      },
    },
  };
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  seedUsers();
  vi.mocked(connectionManager.sendToDmMembers).mockReset();
});

describe('processOwnershipTransferEvent — authority + canonicalization', () => {
  it('accepts a transfer when ownerHomeInstance is BARE and sourceInstance is FULL (legacy storage)', async () => {
    // Legacy state — `transferGroupDmOwnership` used to copy `users.homeInstance`
    // verbatim (bare host) for federated new owners. With the fix, this
    // pre-existing row must still accept legitimate inbound transfers.
    seedChannel({ ownerHomeInstance: OWNER_ORIGIN_BARE });
    const fed = await import('./federation.js');
    const event = buildTransferEvent();

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processOwnershipTransferEvent(event, OWNER_ORIGIN_FULL, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual([event.messageId]);

    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(channel?.ownerId).toBe(NEW_OWNER_USER_ID);
    expect(channel?.ownerHomeUserId).toBe(NEW_OWNER_HOME_USER_ID);
    // Receiver canonicalizes to full URL on storage so future authority
    // checks are stable regardless of what the wire format was.
    expect(channel?.ownerHomeInstance).toBe(NEW_OWNER_ORIGIN_FULL);
  });

  it('accepts a transfer when ownerHomeInstance is FULL and sourceInstance is FULL (current happy path)', async () => {
    seedChannel({ ownerHomeInstance: OWNER_ORIGIN_FULL });
    const fed = await import('./federation.js');
    const event = buildTransferEvent();

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processOwnershipTransferEvent(event, OWNER_ORIGIN_FULL, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual([event.messageId]);
    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(channel?.ownerId).toBe(NEW_OWNER_USER_ID);
    expect(channel?.ownerHomeInstance).toBe(NEW_OWNER_ORIGIN_FULL);
  });

  it('rejects a transfer when the source peer cannot attest the previous owner (attribution_mismatch)', async () => {
    // First-line attribution check: `previousOwner.homeInstance` must match
    // `sourceInstance` (or be us). An attacker peer cannot attest a transfer
    // on behalf of a user whose home isn't them.
    seedChannel({ ownerHomeInstance: OWNER_ORIGIN_FULL });
    const fed = await import('./federation.js');
    const event = buildTransferEvent({ messageId: 'evt-transfer-bad-source' });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processOwnershipTransferEvent(event, 'https://attacker.test', testDb, accepted, rejected);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ messageId: event.messageId, reason: 'attribution_mismatch' }]);

    // No mutation
    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(channel?.ownerId).toBe(OWNER_USER_ID);
    expect(channel?.ownerHomeInstance).toBe(OWNER_ORIGIN_FULL);
  });

  it('rejects a transfer when the source matches previousOwner but is NOT the channel\'s current owner instance (unauthorized_source)', async () => {
    // Authority check at the channel level: even if a peer can attest the
    // previous owner, the channel's current `ownerHomeInstance` must still
    // match the source. This guards against an outdated peer trying to
    // forward an old transfer after ownership has moved on.
    //
    // Setup: channel currently owned by `new.test` (after some other prior
    // transfer this receiver already applied). An event arrives FROM
    // `owner.test` claiming `previousOwner` is on `owner.test`. Attribution
    // is fine (source attests its own user), but the channel says the
    // current authority is `new.test` — reject as `unauthorized_source`.
    seedChannel({ ownerHomeInstance: NEW_OWNER_ORIGIN_FULL });
    const fed = await import('./federation.js');
    const event = buildTransferEvent({
      messageId: 'evt-transfer-stale-source',
      previousOwnerHomeInstance: OWNER_ORIGIN_FULL,
    });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processOwnershipTransferEvent(event, OWNER_ORIGIN_FULL, testDb, accepted, rejected);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ messageId: event.messageId, reason: 'unauthorized_source' }]);
  });

  it('canonicalizes ownerHomeInstance on storage even when the wire payload sends a bare host', async () => {
    // Defensive: a legacy peer may still send the bare host on the wire after
    // an upgrade. Receiver storage must end up canonical regardless.
    seedChannel({ ownerHomeInstance: OWNER_ORIGIN_FULL });
    const fed = await import('./federation.js');
    const event = buildTransferEvent({
      messageId: 'evt-transfer-bare-wire',
      newOwnerHomeInstance: NEW_OWNER_ORIGIN_BARE,
    });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processOwnershipTransferEvent(event, OWNER_ORIGIN_FULL, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual([event.messageId]);
    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(channel?.ownerHomeInstance).toBe(NEW_OWNER_ORIGIN_FULL);
  });

  it('broadcasts dm_owner_updated with newOwnerHomeUserId + newOwnerHomeInstance so clients keep owner-routing fresh', async () => {
    seedChannel({ ownerHomeInstance: OWNER_ORIGIN_FULL });
    const fed = await import('./federation.js');
    const event = buildTransferEvent({ messageId: 'evt-transfer-broadcast' });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processOwnershipTransferEvent(event, OWNER_ORIGIN_FULL, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    const sendSpy = vi.mocked(connectionManager.sendToDmMembers);
    const ownerUpdatedCalls = sendSpy.mock.calls.filter(c => (c[1] as { type?: string }).type === 'dm_owner_updated');
    expect(ownerUpdatedCalls).toHaveLength(1);
    const payload = ownerUpdatedCalls[0]![1] as {
      type: string;
      dmChannelId: string;
      newOwnerId: string;
      newOwnerHomeUserId?: string | null;
      newOwnerHomeInstance?: string | null;
    };
    expect(payload).toMatchObject({
      type: 'dm_owner_updated',
      dmChannelId: CHANNEL_ID,
      newOwnerId: NEW_OWNER_USER_ID,
      newOwnerHomeUserId: NEW_OWNER_HOME_USER_ID,
      newOwnerHomeInstance: NEW_OWNER_ORIGIN_FULL,
    });
  });

  it('is idempotent on replay — repeats short-circuit at the (sourceInstance, messageId) dedup', async () => {
    seedChannel({ ownerHomeInstance: OWNER_ORIGIN_BARE });
    const fed = await import('./federation.js');
    const event = buildTransferEvent({ messageId: 'evt-transfer-replay' });

    const accepted1: string[] = [];
    const rejected1: Array<{ messageId: string; reason: string }> = [];
    fed.processOwnershipTransferEvent(event, OWNER_ORIGIN_FULL, testDb, accepted1, rejected1);

    // Second delivery — the new ownerHomeInstance on the channel is now
    // `new.test`; running the same event again must NOT clobber owner back
    // because the dedup short-circuits.
    const accepted2: string[] = [];
    const rejected2: Array<{ messageId: string; reason: string }> = [];
    fed.processOwnershipTransferEvent(event, OWNER_ORIGIN_FULL, testDb, accepted2, rejected2);

    expect(accepted1).toEqual([event.messageId]);
    expect(accepted2).toEqual([event.messageId]);
    expect(rejected1).toEqual([]);
    expect(rejected2).toEqual([]);

    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(channel?.ownerId).toBe(NEW_OWNER_USER_ID);

    // Only one system message inserted across two deliveries
    const sysRows = testDb.select().from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, CHANNEL_ID))
      .all();
    expect(sysRows.filter(r => r.sourceMessageId === event.messageId)).toHaveLength(1);
  });
});
