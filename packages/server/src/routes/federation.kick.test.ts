import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, and } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { FederationRelayEvent, FederationRelayParticipant } from '@backspace/shared';

setWorkerId(4);

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
    uploadDir: '/tmp/bs-fed-kick-test',
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

const OWNER_ORIGIN = 'https://owner.test';
const ATTACKER_ORIGIN = 'https://attacker.test';
const RANDOM_ORIGIN = 'https://random.test';

const FEDERATED_ID = 'fed-channel-kick-1';
const CHANNEL_ID = 'ch-kick-local-1';

const OWNER_USER_ID = 'owner-user-stub';
const OWNER_HOME_USER_ID = 'home-owner-1';

const VICTIM_USER_ID = 'victim-user-stub';
const VICTIM_HOME_USER_ID = 'home-victim-1';
const VICTIM_HOME_INSTANCE = 'https://victim.test';

const LEAVER_USER_ID = 'leaver-user-stub';
const LEAVER_HOME_USER_ID = 'home-leaver-1';
const LEAVER_HOME_INSTANCE = RANDOM_ORIGIN;

/**
 * Seed a federated group DM channel where:
 *   - Owner is a replicated user from `OWNER_ORIGIN`
 *   - A victim member is a replicated user from `VICTIM_HOME_INSTANCE` (used for kick tests)
 *   - A leaver member is a replicated user from `LEAVER_HOME_INSTANCE` (used for the leave test)
 *
 * `ownerHomeInstance` is stored as the full origin string (`https://owner.test`)
 * to match the kick authority check, which compares `sourceInstance` to
 * `ownerHomeInstance` via strict string equality (federation.ts:4350).
 */
function seedChannelAndMembers(): void {
  const now = Date.now();
  testDb.insert(schema.users).values({
    id: OWNER_USER_ID,
    username: `owner@owner.test`,
    displayName: 'owner',
    passwordHash: '!federation-replicated',
    status: 'offline',
    isAdmin: 0,
    homeInstance: OWNER_ORIGIN,
    homeUserId: OWNER_HOME_USER_ID,
    createdAt: now,
  }).run();

  testDb.insert(schema.users).values({
    id: VICTIM_USER_ID,
    username: `victim@victim.test`,
    displayName: 'victim',
    passwordHash: '!federation-replicated',
    status: 'offline',
    isAdmin: 0,
    homeInstance: VICTIM_HOME_INSTANCE,
    homeUserId: VICTIM_HOME_USER_ID,
    createdAt: now,
  }).run();

  testDb.insert(schema.users).values({
    id: LEAVER_USER_ID,
    username: `leaver@random.test`,
    displayName: 'leaver',
    passwordHash: '!federation-replicated',
    status: 'offline',
    isAdmin: 0,
    homeInstance: LEAVER_HOME_INSTANCE,
    homeUserId: LEAVER_HOME_USER_ID,
    createdAt: now,
  }).run();

  testDb.insert(schema.dmChannels).values({
    id: CHANNEL_ID,
    federatedId: FEDERATED_ID,
    ownerId: OWNER_USER_ID,
    ownerHomeUserId: OWNER_HOME_USER_ID,
    ownerHomeInstance: OWNER_ORIGIN,
    name: 'group',
    icon: null,
    metadataUpdatedAt: 1000,
    createdAt: now,
  }).run();

  testDb.insert(schema.dmMembers).values({ dmChannelId: CHANNEL_ID, userId: OWNER_USER_ID, closed: 0 }).run();
  testDb.insert(schema.dmMembers).values({ dmChannelId: CHANNEL_ID, userId: VICTIM_USER_ID, closed: 0 }).run();
  testDb.insert(schema.dmMembers).values({ dmChannelId: CHANNEL_ID, userId: LEAVER_USER_ID, closed: 0 }).run();
}

function ownerActor(): FederationRelayParticipant {
  return {
    homeUserId: OWNER_HOME_USER_ID,
    homeInstance: OWNER_ORIGIN,
    profile: { username: 'owner', displayName: 'owner' },
  };
}

function victimActor(): FederationRelayParticipant {
  return {
    homeUserId: VICTIM_HOME_USER_ID,
    homeInstance: VICTIM_HOME_INSTANCE,
    profile: { username: 'victim', displayName: 'victim' },
  };
}

function leaverActor(): FederationRelayParticipant {
  return {
    homeUserId: LEAVER_HOME_USER_ID,
    homeInstance: LEAVER_HOME_INSTANCE,
    profile: { username: 'leaver', displayName: 'leaver' },
  };
}

function buildKickEvent(messageId = 'evt-kick-1'): FederationRelayEvent {
  return {
    eventType: 'member_remove',
    contextType: 'dm',
    messageId,
    federatedId: FEDERATED_ID,
    encryptionVersion: 0,
    timestamp: Date.now(),
    membership: {
      user: victimActor(),
      removedBy: ownerActor(),
      reason: 'kick',
    },
  };
}

function buildLeaveEvent(messageId = 'evt-leave-1'): FederationRelayEvent {
  return {
    eventType: 'member_remove',
    contextType: 'dm',
    messageId,
    federatedId: FEDERATED_ID,
    encryptionVersion: 0,
    timestamp: Date.now(),
    membership: {
      user: leaverActor(),
      removedBy: leaverActor(),
      reason: 'leave',
    },
  };
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  vi.mocked(connectionManager.sendToDmMembers).mockReset();
});

describe('processMemberRemoveEvent — kick authority', () => {
  it('accepts a kick from the owner instance, deletes the member, inserts a system message, and broadcasts dm_member_removed', async () => {
    seedChannelAndMembers();
    const fed = await import('./federation.js');
    const event = buildKickEvent();

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processMemberRemoveEvent(event, OWNER_ORIGIN, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual([event.messageId]);

    // Victim's dm_members row was deleted
    const victimRow = testDb.select().from(schema.dmMembers)
      .where(and(eq(schema.dmMembers.dmChannelId, CHANNEL_ID), eq(schema.dmMembers.userId, VICTIM_USER_ID)))
      .get();
    expect(victimRow).toBeUndefined();

    // System message inserted, tagged with source for dedup, with reason=kick
    const sysRows = testDb.select().from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, CHANNEL_ID))
      .all();
    expect(sysRows).toHaveLength(1);
    const sys = sysRows[0]!;
    expect(sys.type).toBe('system');
    expect(sys.sourceInstance).toBe(OWNER_ORIGIN);
    expect(sys.sourceMessageId).toBe(event.messageId);
    const parsed = JSON.parse(sys.content!);
    expect(parsed.event).toBe('member_removed');
    expect(parsed.reason).toBe('kick');
    expect(parsed.targetUserId).toBe(VICTIM_USER_ID);

    // Two broadcasts fire: one for the system message, one for dm_member_removed
    const sendSpy = vi.mocked(connectionManager.sendToDmMembers);
    const removalCalls = sendSpy.mock.calls.filter(c => (c[1] as { type?: string }).type === 'dm_member_removed');
    expect(removalCalls).toHaveLength(1);
    const removalPayload = removalCalls[0]![1] as { type: string; dmChannelId: string; userId: string };
    expect(removalPayload).toEqual({
      type: 'dm_member_removed',
      dmChannelId: CHANNEL_ID,
      userId: VICTIM_USER_ID,
    });
  });

  it('rejects a kick from a non-owner instance and performs no mutation (current behavior: reason=unauthorized_source)', async () => {
    seedChannelAndMembers();
    const fed = await import('./federation.js');
    const event = buildKickEvent('evt-kick-attacker');

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processMemberRemoveEvent(event, ATTACKER_ORIGIN, testDb, accepted, rejected);

    expect(accepted).toEqual([]);
    // Receiver currently emits `unauthorized_source` for non-owner kicks; the
    // group-DM-polish plan describes this rejection as `attribution_mismatch`.
    // The lock-in goal here is current behavior, so we assert the actual
    // string. Tighten this if the receiver is changed to align with the plan
    // wording — see federation.ts:processMemberRemoveEvent line ~4350.
    expect(rejected).toEqual([{ messageId: event.messageId, reason: 'unauthorized_source' }]);

    // Victim's dm_members row is STILL present (no mutation)
    const victimRow = testDb.select().from(schema.dmMembers)
      .where(and(eq(schema.dmMembers.dmChannelId, CHANNEL_ID), eq(schema.dmMembers.userId, VICTIM_USER_ID)))
      .get();
    expect(victimRow).toBeDefined();

    // No system message inserted
    const sysRows = testDb.select().from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, CHANNEL_ID))
      .all();
    expect(sysRows).toHaveLength(0);

    // No broadcast emitted at all
    expect(vi.mocked(connectionManager.sendToDmMembers)).not.toHaveBeenCalled();
  });

  it('accepts a kick when ownerHomeInstance is BARE and sourceInstance is FULL (bare-vs-full normalization)', async () => {
    // Regression: pre-fix, `processMemberRemoveEvent` compared
    // `sourceInstance` (full URL, from outbox worker) to `ownerHomeInstance`
    // verbatim. After an `ownership_transfer` to a federated user, the
    // column would be written as a bare host (`users.homeInstance`), causing
    // legitimate downstream kicks to be rejected with `unauthorized_source`.
    //
    // The fix normalizes both sides via `normalizeOriginForCompare`. This
    // test re-seeds the channel with a bare `ownerHomeInstance` to lock in
    // the new behavior. Mirrors the ownership-transfer authority test.
    seedChannelAndMembers();
    // Overwrite ownerHomeInstance to the legacy bare form.
    testDb.update(schema.dmChannels)
      .set({ ownerHomeInstance: 'owner.test' })
      .where(eq(schema.dmChannels.id, CHANNEL_ID))
      .run();

    const fed = await import('./federation.js');
    const event = buildKickEvent('evt-kick-bare-owner');

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    fed.processMemberRemoveEvent(event, OWNER_ORIGIN, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual([event.messageId]);

    // Victim's dm_members row was deleted (kick applied)
    const victimRow = testDb.select().from(schema.dmMembers)
      .where(and(eq(schema.dmMembers.dmChannelId, CHANNEL_ID), eq(schema.dmMembers.userId, VICTIM_USER_ID)))
      .get();
    expect(victimRow).toBeUndefined();
  });

  it('accepts a self-leave from any source instance (not the owner instance) and removes the leaver', async () => {
    seedChannelAndMembers();
    const fed = await import('./federation.js');
    const event = buildLeaveEvent();

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    // sourceInstance == leaver's home instance (RANDOM_ORIGIN), which is NOT
    // the owner's home instance — verifyAttribution still passes because the
    // leaving user belongs to the source.
    fed.processMemberRemoveEvent(event, RANDOM_ORIGIN, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual([event.messageId]);

    // Leaver's dm_members row was deleted
    const leaverRow = testDb.select().from(schema.dmMembers)
      .where(and(eq(schema.dmMembers.dmChannelId, CHANNEL_ID), eq(schema.dmMembers.userId, LEAVER_USER_ID)))
      .get();
    expect(leaverRow).toBeUndefined();

    // System message inserted with reason=leave
    const sysRows = testDb.select().from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, CHANNEL_ID))
      .all();
    expect(sysRows).toHaveLength(1);
    const parsed = JSON.parse(sysRows[0]!.content!);
    expect(parsed.event).toBe('member_removed');
    expect(parsed.reason).toBe('leave');
    expect(parsed.targetUserId).toBe(LEAVER_USER_ID);

    // dm_member_removed broadcast fires
    const sendSpy = vi.mocked(connectionManager.sendToDmMembers);
    const removalCalls = sendSpy.mock.calls.filter(c => (c[1] as { type?: string }).type === 'dm_member_removed');
    expect(removalCalls).toHaveLength(1);
    expect(removalCalls[0]![1]).toEqual({
      type: 'dm_member_removed',
      dmChannelId: CHANNEL_ID,
      userId: LEAVER_USER_ID,
    });
  });
});
