import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq, and } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { FederationRelayEvent, FederationRelayParticipant } from '@backspace/shared';

setWorkerId(3);

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
    // Set in beforeEach via reassignment trick — vi.mock factory runs once.
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
import { deleteUploadFile } from '../utils/fileCleanup.js';

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
const FEDERATED_ID = 'fed-channel-1';
const CHANNEL_ID = 'ch-local-1';
const OWNER_ID = 'owner-stub-1';
const MEMBER_ID = 'member-local-1';

function seedChannelAndOwner(opts: {
  channelName: string | null;
  channelIcon: string | null;
  metadataUpdatedAt: number;
}): void {
  testDb.insert(schema.users).values({
    id: OWNER_ID,
    username: `owner@${OWNER_INSTANCE}`,
    displayName: 'owner',
    passwordHash: '!federation-replicated',
    status: 'offline',
    isAdmin: 0,
    homeInstance: OWNER_INSTANCE,
    homeUserId: 'home-owner-1',
    createdAt: Date.now(),
  }).run();

  testDb.insert(schema.users).values({
    id: MEMBER_ID,
    username: 'localmember',
    displayName: 'localmember',
    passwordHash: 'hash',
    status: 'online',
    isAdmin: 0,
    createdAt: Date.now(),
  }).run();

  testDb.insert(schema.dmChannels).values({
    id: CHANNEL_ID,
    federatedId: FEDERATED_ID,
    ownerId: OWNER_ID,
    ownerHomeUserId: 'home-owner-1',
    ownerHomeInstance: OWNER_INSTANCE,
    name: opts.channelName,
    icon: opts.channelIcon,
    metadataUpdatedAt: opts.metadataUpdatedAt,
    createdAt: Date.now(),
  }).run();

  testDb.insert(schema.dmMembers).values({
    dmChannelId: CHANNEL_ID,
    userId: OWNER_ID,
    closed: 0,
  }).run();
  testDb.insert(schema.dmMembers).values({
    dmChannelId: CHANNEL_ID,
    userId: MEMBER_ID,
    closed: 0,
  }).run();
}

function ownerActor(): FederationRelayParticipant {
  return {
    homeUserId: 'home-owner-1',
    homeInstance: OWNER_INSTANCE,
    profile: { username: 'owner', displayName: 'owner' },
  };
}

function buildEvent(opts: {
  messageId?: string;
  name: string | null;
  icon: string | null;
  metadataUpdatedAt: number;
  actor?: FederationRelayParticipant;
}): FederationRelayEvent {
  return {
    eventType: 'group_metadata_update',
    contextType: 'dm',
    messageId: opts.messageId ?? 'evt-1',
    federatedId: FEDERATED_ID,
    encryptionVersion: 0,
    timestamp: Date.now(),
    metadata: {
      name: opts.name,
      icon: opts.icon,
      metadataUpdatedAt: opts.metadataUpdatedAt,
      actor: opts.actor ?? ownerActor(),
    },
  };
}

// Build a tiny PNG byte stream (1x1 transparent) so the disk write in
// downloadProfileAsset succeeds with a valid `image/*` content-type.
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

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  tmpUploadDir = path.join(os.tmpdir(), `bs-fed-meta-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmpUploadDir, { recursive: true });
  vi.mocked(connectionManager.sendToDmMembers).mockReset();
  vi.mocked(deleteUploadFile).mockReset();
});

afterEach(() => {
  try { fs.rmSync(tmpUploadDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.unstubAllGlobals();
});

describe('processGroupMetadataUpdateEvent — authority', () => {
  it('accepts and mutates the channel when sourceInstance matches ownerHomeInstance', async () => {
    seedChannelAndOwner({ channelName: 'old', channelIcon: null, metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    const event = buildEvent({ name: 'new name', icon: null, metadataUpdatedAt: 2000 });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_INSTANCE, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['evt-1']);
    const row = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(row!.name).toBe('new name');
    expect(row!.metadataUpdatedAt).toBe(2000);
  });

  it('rejects with attribution_mismatch when sourceInstance differs from ownerHomeInstance', async () => {
    seedChannelAndOwner({ channelName: 'old', channelIcon: null, metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    const event = buildEvent({ name: 'evil', icon: null, metadataUpdatedAt: 2000 });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, 'evil.example.com', testDb, accepted, rejected);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ messageId: 'evt-1', reason: 'attribution_mismatch' }]);
    const row = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(row!.name).toBe('old');
    expect(row!.metadataUpdatedAt).toBe(1000);
  });
});

describe('processGroupMetadataUpdateEvent — version check', () => {
  it('silently accepts a stale metadataUpdatedAt without mutating the channel', async () => {
    seedChannelAndOwner({ channelName: 'current', channelIcon: null, metadataUpdatedAt: 5000 });
    const fed = await import('./federation.js');
    const event = buildEvent({ name: 'older', icon: null, metadataUpdatedAt: 3000 });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_INSTANCE, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['evt-1']);
    const row = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(row!.name).toBe('current');
    expect(row!.metadataUpdatedAt).toBe(5000);
    const sysRows = testDb.select().from(schema.dmMessages).where(eq(schema.dmMessages.dmChannelId, CHANNEL_ID)).all();
    expect(sysRows).toHaveLength(0);
  });
});

describe('processGroupMetadataUpdateEvent — receiver hardening', () => {
  it('rejects an oversized name with invalid_payload', async () => {
    seedChannelAndOwner({ channelName: 'old', channelIcon: null, metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    const event = buildEvent({ name: 'a'.repeat(10_000), icon: null, metadataUpdatedAt: 2000 });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_INSTANCE, testDb, accepted, rejected);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ messageId: 'evt-1', reason: 'invalid_payload' }]);
    const row = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(row!.name).toBe('old');
  });

  it('rejects a non-http(s) icon URL with invalid_payload', async () => {
    seedChannelAndOwner({ channelName: 'old', channelIcon: null, metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    const event = buildEvent({
      name: null,
      icon: '/api/uploads/foo.png',
      metadataUpdatedAt: 2000,
    });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_INSTANCE, testDb, accepted, rejected);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ messageId: 'evt-1', reason: 'invalid_payload' }]);
  });

  it('rejects a missing metadata payload with missing_metadata_payload', async () => {
    seedChannelAndOwner({ channelName: 'old', channelIcon: null, metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    const event: FederationRelayEvent = {
      eventType: 'group_metadata_update',
      contextType: 'dm',
      messageId: 'evt-1',
      federatedId: FEDERATED_ID,
      encryptionVersion: 0,
      timestamp: Date.now(),
      // metadata intentionally omitted
    };

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_INSTANCE, testDb, accepted, rejected);

    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ messageId: 'evt-1', reason: 'missing_metadata_payload' }]);
  });
});

describe('processGroupMetadataUpdateEvent — icon download', () => {
  it('caches the downloaded icon as a local filename on success', async () => {
    seedChannelAndOwner({ channelName: 'g', channelIcon: null, metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    vi.stubGlobal('fetch', vi.fn(async () => makeImageResponse()));

    const remoteIcon = `${OWNER_ORIGIN}/api/uploads/icon-remote.png`;
    const event = buildEvent({ name: null, icon: remoteIcon, metadataUpdatedAt: 2000 });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_ORIGIN, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    const row = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(row!.icon).not.toBeNull();
    expect(row!.icon!.startsWith('http')).toBe(false); // local filename, not URL
    expect(row!.icon).toMatch(/\.png$/);
    // File was actually written to the temp upload dir
    expect(fs.existsSync(path.join(tmpUploadDir, row!.icon!))).toBe(true);
  });

  it('falls back to the absolute URL when the download fails', async () => {
    seedChannelAndOwner({ channelName: 'g', channelIcon: null, metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    vi.stubGlobal('fetch', vi.fn(async () => makeFailureResponse()));

    const remoteIcon = `${OWNER_ORIGIN}/api/uploads/icon-remote.png`;
    const event = buildEvent({ name: null, icon: remoteIcon, metadataUpdatedAt: 2000 });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_ORIGIN, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    const row = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(row!.icon).toBe(remoteIcon);
  });
});

describe('processGroupMetadataUpdateEvent — system messages', () => {
  it('inserts two system messages with :name and :icon dedup suffixes when both change', async () => {
    seedChannelAndOwner({ channelName: 'old', channelIcon: null, metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    vi.stubGlobal('fetch', vi.fn(async () => makeImageResponse()));

    const remoteIcon = `${OWNER_ORIGIN}/api/uploads/icon.png`;
    const event = buildEvent({
      messageId: 'evt-multi',
      name: 'fresh',
      icon: remoteIcon,
      metadataUpdatedAt: 2000,
    });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_ORIGIN, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['evt-multi']);

    const sysRows = testDb.select().from(schema.dmMessages).where(eq(schema.dmMessages.dmChannelId, CHANNEL_ID)).all();
    expect(sysRows).toHaveLength(2);
    const sourceMessageIds = sysRows.map(r => r.sourceMessageId).sort();
    expect(sourceMessageIds).toEqual(['evt-multi:icon', 'evt-multi:name']);
    for (const r of sysRows) {
      expect(r.sourceInstance).toBe(OWNER_ORIGIN);
      expect(r.type).toBe('system');
    }
    const nameRow = sysRows.find(r => r.sourceMessageId === 'evt-multi:name')!;
    expect(JSON.parse(nameRow.content!)).toEqual({ event: 'name_changed', oldName: 'old', newName: 'fresh' });
    const iconRow = sysRows.find(r => r.sourceMessageId === 'evt-multi:icon')!;
    expect(JSON.parse(iconRow.content!)).toEqual({ event: 'icon_changed' });
  });

  it('is idempotent — a second delivery of the same event creates no additional rows', async () => {
    seedChannelAndOwner({ channelName: 'old', channelIcon: null, metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    const event = buildEvent({ messageId: 'evt-retry', name: 'fresh', icon: null, metadataUpdatedAt: 2000 });

    const accepted1: string[] = [];
    const rejected1: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_INSTANCE, testDb, accepted1, rejected1);
    expect(rejected1).toEqual([]);
    expect(accepted1).toEqual(['evt-retry']);

    const sendSpy = vi.mocked(connectionManager.sendToDmMembers);
    const callsAfterFirst = sendSpy.mock.calls.length;

    // Reset metadataUpdatedAt back so the version-check doesn't short-circuit
    // before the dedup check. (Forcing the redelivery to actually exercise the
    // dedup logic, not the cheaper version short-circuit.)
    testDb.update(schema.dmChannels)
      .set({ metadataUpdatedAt: 1000, name: 'old' })
      .where(eq(schema.dmChannels.id, CHANNEL_ID))
      .run();

    const accepted2: string[] = [];
    const rejected2: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_INSTANCE, testDb, accepted2, rejected2);
    expect(rejected2).toEqual([]);
    expect(accepted2).toEqual(['evt-retry']);

    const sysRows = testDb.select().from(schema.dmMessages)
      .where(and(
        eq(schema.dmMessages.dmChannelId, CHANNEL_ID),
        eq(schema.dmMessages.sourceMessageId, 'evt-retry:name'),
      )).all();
    expect(sysRows).toHaveLength(1);
    // No additional broadcasts on retry.
    expect(sendSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('treats a no-op (received metadata identical to local) as a silent accept', async () => {
    seedChannelAndOwner({ channelName: 'same', channelIcon: null, metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    const event = buildEvent({
      name: 'same',
      icon: null,
      // Bump timestamp so the version-check passes — no-op detection must
      // happen on the diff, not just on the timestamp.
      metadataUpdatedAt: 2000,
    });

    const sendSpy = vi.mocked(connectionManager.sendToDmMembers);
    sendSpy.mockClear();

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_INSTANCE, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['evt-1']);
    const sysRows = testDb.select().from(schema.dmMessages).where(eq(schema.dmMessages.dmChannelId, CHANNEL_ID)).all();
    expect(sysRows).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('processGroupMetadataUpdateEvent — icon clear', () => {
  it('clears the icon and unlinks the previous local file', async () => {
    seedChannelAndOwner({ channelName: null, channelIcon: 'old-local.png', metadataUpdatedAt: 1000 });
    const fed = await import('./federation.js');
    const event = buildEvent({ name: null, icon: null, metadataUpdatedAt: 2000 });

    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await fed.processGroupMetadataUpdateEvent(event, OWNER_INSTANCE, testDb, accepted, rejected);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['evt-1']);
    const row = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, CHANNEL_ID)).get();
    expect(row!.icon).toBeNull();

    const sysRows = testDb.select().from(schema.dmMessages).where(eq(schema.dmMessages.dmChannelId, CHANNEL_ID)).all();
    expect(sysRows).toHaveLength(1);
    expect(JSON.parse(sysRows[0]!.content!)).toEqual({ event: 'icon_changed' });

    expect(deleteUploadFile).toHaveBeenCalledWith('old-local.png');
  });
});
