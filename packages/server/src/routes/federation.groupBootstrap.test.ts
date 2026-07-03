import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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
let tmpUploadDir: string;

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
    get uploadDir(): string { return tmpUploadDir; },
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

vi.mock('../utils/fileCleanup.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fileCleanup.js')>('../utils/fileCleanup.js');
  return {
    ...actual,
    deleteUploadFile: vi.fn(),
    deleteAttachmentByFilename: vi.fn(),
    deleteAttachmentFiles: vi.fn(),
  };
});

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

const OWNER_INSTANCE = 'orbit.ddns.net';
const OWNER_ORIGIN = `https://${OWNER_INSTANCE}`;
const FEDERATED_ID = 'fed-bootstrap-1';

// Tiny PNG body for fetch stubs — matches the shape downloadProfileAsset
// expects (image/* content-type, non-empty body).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63600000000200015d3a87' +
    '6f0000000049454e44ae426082',
  'hex',
);

function makeImageResponse(): Response {
  return new Response(TINY_PNG, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

function makeFailureResponse(): Response {
  return new Response('boom', { status: 500 });
}

/**
 * Build a member_add event whose group payload bootstraps a fresh peer.
 * Optional fields default to safe values so tests can omit them when
 * exercising the "older peer that doesn't yet emit the new fields" branch.
 */
function buildBootstrapEvent(opts: {
  messageId?: string;
  name?: string | null;
  icon?: string | null;
  metadataUpdatedAt?: number;
  // When true, omit the metadata fields entirely (older-peer payload).
  omitMetadataFields?: boolean;
}): FederationRelayEvent {
  const group: FederationRelayEvent['group'] = {
    owner: {
      homeUserId: 'home-owner-1',
      homeInstance: OWNER_INSTANCE,
      profile: { username: 'owner', displayName: 'owner' },
    },
    members: [
      {
        homeUserId: 'home-owner-1',
        homeInstance: OWNER_INSTANCE,
        profile: { username: 'owner', displayName: 'owner' },
      },
      {
        homeUserId: 'home-added-1',
        homeInstance: OWNER_INSTANCE,
        profile: { username: 'added', displayName: 'added' },
      },
    ],
    // Defaults match what an older peer emits; explicit overrides below.
    name: null,
    icon: null,
    metadataUpdatedAt: 0,
  };

  if (!opts.omitMetadataFields) {
    group.name = opts.name ?? null;
    group.icon = opts.icon ?? null;
    group.metadataUpdatedAt = opts.metadataUpdatedAt ?? 0;
  } else {
    // Simulate an older peer's payload by deleting the metadata-snapshot
    // fields entirely. Validates the consumer's `?? null`/`?? 0` fallbacks.
    delete (group as Partial<typeof group>).name;
    delete (group as Partial<typeof group>).icon;
    delete (group as Partial<typeof group>).metadataUpdatedAt;
  }

  return {
    eventType: 'member_add',
    contextType: 'dm',
    messageId: opts.messageId ?? 'evt-bootstrap-1',
    federatedId: FEDERATED_ID,
    encryptionVersion: 0,
    timestamp: Date.now(),
    membership: {
      user: {
        homeUserId: 'home-added-1',
        homeInstance: OWNER_INSTANCE,
        profile: { username: 'added', displayName: 'added' },
      },
      addedBy: {
        homeUserId: 'home-owner-1',
        homeInstance: OWNER_INSTANCE,
        profile: { username: 'owner', displayName: 'owner' },
      },
    },
    group,
  };
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  tmpUploadDir = path.join(os.tmpdir(), `bs-fed-bootstrap-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmpUploadDir, { recursive: true });
  vi.mocked(connectionManager.sendToUser).mockReset();
  vi.mocked(connectionManager.sendToDmMembers).mockReset();
});

afterEach(() => {
  try { fs.rmSync(tmpUploadDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.unstubAllGlobals();
});

describe('processMemberAddEvent — bootstrap with group metadata snapshot', () => {
  it('creates the channel with name and downloaded icon when the icon fetch succeeds', async () => {
    const fed = await import('./federation.js');
    vi.stubGlobal('fetch', vi.fn(async () => makeImageResponse()));

    const event = buildBootstrapEvent({
      name: 'Cool Group',
      icon: `${OWNER_ORIGIN}/api/uploads/x.png`,
      metadataUpdatedAt: 12345,
    });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processMemberAddEvent(event, OWNER_ORIGIN, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['evt-bootstrap-1']);

    const row = testDb.select().from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, FEDERATED_ID)).get();
    expect(row).toBeDefined();
    expect(row!.name).toBe('Cool Group');
    expect(row!.metadataUpdatedAt).toBe(12345);
    // Icon was downloaded → stored as local filename, not absolute URL
    expect(row!.icon).not.toBeNull();
    expect(row!.icon!.startsWith('http')).toBe(false);
    expect(row!.icon).toMatch(/\.png$/);
    expect(fs.existsSync(path.join(tmpUploadDir, row!.icon!))).toBe(true);
  });

  it('falls back to the absolute URL when the icon download fails', async () => {
    const fed = await import('./federation.js');
    vi.stubGlobal('fetch', vi.fn(async () => makeFailureResponse()));

    const remoteIcon = `${OWNER_ORIGIN}/api/uploads/x.png`;
    const event = buildBootstrapEvent({
      name: 'Group With Failed Icon',
      icon: remoteIcon,
      metadataUpdatedAt: 999,
    });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processMemberAddEvent(event, OWNER_ORIGIN, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    const row = testDb.select().from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, FEDERATED_ID)).get();
    expect(row!.name).toBe('Group With Failed Icon');
    expect(row!.icon).toBe(remoteIcon);
    expect(row!.metadataUpdatedAt).toBe(999);
  });

  it('records metadataUpdatedAt so subsequent stale group_metadata_update events are rejected', async () => {
    const fed = await import('./federation.js');
    const event = buildBootstrapEvent({
      name: 'Versioned',
      icon: null,
      metadataUpdatedAt: 12345,
    });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processMemberAddEvent(event, OWNER_INSTANCE, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    const row = testDb.select().from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, FEDERATED_ID)).get();
    expect(row!.metadataUpdatedAt).toBe(12345);

    // Replay a stale metadata-update with timestamp <= bootstrap value.
    // The receiver must silently accept and not mutate the channel.
    const staleMeta: FederationRelayEvent = {
      eventType: 'group_metadata_update',
      contextType: 'dm',
      messageId: 'stale-meta-1',
      federatedId: FEDERATED_ID,
      encryptionVersion: 0,
      timestamp: Date.now(),
      metadata: {
        name: 'older name',
        icon: null,
        metadataUpdatedAt: 12345, // equal to bootstrap → stale by <=
        actor: {
          homeUserId: 'home-owner-1',
          homeInstance: OWNER_INSTANCE,
          profile: { username: 'owner', displayName: 'owner' },
        },
      },
    };

    const accepted2: string[] = [];
    const rejected2: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(staleMeta, OWNER_INSTANCE, testDb, accepted2, rejected2);
    expect(rejected2).toEqual([]);
    expect(accepted2).toEqual(['stale-meta-1']);

    const rowAfter = testDb.select().from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, FEDERATED_ID)).get();
    expect(rowAfter!.name).toBe('Versioned');
    expect(rowAfter!.metadataUpdatedAt).toBe(12345);
  });

  it('falls back to safe defaults when the older-peer payload omits the metadata fields', async () => {
    const fed = await import('./federation.js');

    const event = buildBootstrapEvent({ omitMetadataFields: true });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processMemberAddEvent(event, OWNER_INSTANCE, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    const row = testDb.select().from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, FEDERATED_ID)).get();
    expect(row).toBeDefined();
    expect(row!.name).toBeNull();
    expect(row!.icon).toBeNull();
    expect(row!.metadataUpdatedAt).toBe(0);
  });

  it('does not overwrite local metadata when the channel already exists (incremental path)', async () => {
    const fed = await import('./federation.js');

    // Seed: channel already bootstrapped with current metadata. The
    // incremental member_add must not touch any of these fields.
    const channelId = 'ch-existing-1';
    const ownerLocalId = 'owner-stub-1';
    testDb.insert(schema.users).values({
      id: ownerLocalId,
      username: `owner@${OWNER_INSTANCE}`,
      displayName: 'owner',
      passwordHash: '!federation-replicated',
      status: 'offline',
      isAdmin: 0,
      homeInstance: OWNER_INSTANCE,
      homeUserId: 'home-owner-1',
      createdAt: Date.now(),
    }).run();

    const localMemberId = 'local-member-1';
    testDb.insert(schema.users).values({
      id: localMemberId,
      username: 'localmember',
      displayName: 'localmember',
      passwordHash: 'hash',
      status: 'online',
      isAdmin: 0,
      createdAt: Date.now(),
    }).run();

    testDb.insert(schema.dmChannels).values({
      id: channelId,
      federatedId: FEDERATED_ID,
      ownerId: ownerLocalId,
      ownerHomeUserId: 'home-owner-1',
      ownerHomeInstance: OWNER_INSTANCE,
      name: 'Local Current Name',
      icon: 'local-current-icon.png',
      metadataUpdatedAt: 9999,
      createdAt: Date.now(),
    }).run();

    testDb.insert(schema.dmMembers).values({
      dmChannelId: channelId,
      userId: ownerLocalId,
      closed: 0,
    }).run();
    testDb.insert(schema.dmMembers).values({
      dmChannelId: channelId,
      userId: localMemberId,
      closed: 0,
    }).run();

    // Incremental member_add carrying STALE bootstrap metadata. Must not
    // overwrite the local row even though the receiver reads these fields
    // for the bootstrap branch.
    const event = buildBootstrapEvent({
      name: 'STALE bootstrap name',
      icon: `${OWNER_ORIGIN}/api/uploads/stale.png`,
      metadataUpdatedAt: 1, // way older than local 9999
      messageId: 'evt-incremental-1',
    });
    // Replace the added user with a fresh remote member so the incremental
    // path actually inserts a new dm_members row (instead of dedup-ing).
    event.membership!.user = {
      homeUserId: 'home-added-2',
      homeInstance: OWNER_INSTANCE,
      profile: { username: 'added2', displayName: 'added2' },
    };

    // No fetch stub — if the receiver mistakenly tried to download the
    // icon for an existing channel, the un-stubbed call would surface as
    // a thrown ECONNREFUSED. The current implementation downloads only
    // in the bootstrap branch, so this also locks in that scoping.

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processMemberAddEvent(event, OWNER_INSTANCE, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['evt-incremental-1']);

    const row = testDb.select().from(schema.dmChannels)
      .where(eq(schema.dmChannels.id, channelId)).get();
    expect(row!.name).toBe('Local Current Name');
    expect(row!.icon).toBe('local-current-icon.png');
    expect(row!.metadataUpdatedAt).toBe(9999);
  });
});
