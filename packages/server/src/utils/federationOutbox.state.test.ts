import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { setWorkerId } from './snowflake.js';
import type { DmMessageWithUser, User } from '@backspace/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;

// Mutable reference updated in beforeEach — the factory closes over this.
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

// Mock federation-auth helpers to avoid env-var dependency
vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://local.example',
  buildFederationHeaders: () => ({}),
  generateHmacSecret: () => 'test-secret',
}));

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

function seedSettings(autoAcceptPeering: 0 | 1 = 1): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    federationRelayEnabled: 1,
    federationRelayTtlDays: 30,
    autoAcceptPeering,
    updatedAt: Date.now(),
  }).run();
}

function seedPeer(id: string, origin: string, status: string): void {
  testDb.insert(schema.federationPeers).values({
    id, origin, hmacSecret: 'secret',
    status, lastSyncedAt: 0, createdAt: Date.now(),
  }).run();
}

function seedUser(id: string, homeInstance: string | null): void {
  testDb.insert(schema.users).values({
    id,
    username: `user-${id}`,
    passwordHash: 'x',
    homeInstance,
    homeUserId: homeInstance ? `home-${id}` : null,
    createdAt: Date.now(),
  }).run();
}

function seedDmChannel(channelId: string, memberIds: string[]): void {
  testDb.insert(schema.dmChannels).values({
    id: channelId,
    federatedId: `fed-${channelId}`,
    createdAt: Date.now(),
  }).run();
  for (const userId of memberIds) {
    testDb.insert(schema.dmMembers).values({ dmChannelId: channelId, userId }).run();
  }
}

function buildAuthor(id: string, homeInstance: string | null): User {
  return {
    id,
    username: `user-${id}`,
    displayName: null,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: Date.now(),
    homeInstance,
    homeUserId: homeInstance ? `home-${id}` : null,
    replicatedInstances: [],
  };
}

function buildMessage(id: string, dmChannelId: string, author: User, content: string): DmMessageWithUser {
  return {
    id,
    dmChannelId,
    userId: author.id,
    content,
    type: 'user',
    createdAt: Date.now(),
    replyToId: null,
    editedAt: null,
    user: author,
    attachments: [],
    embeds: [],
    reactions: [],
  };
}

function countOutbox(peerId: string): number {
  return testDb.select().from(schema.federationOutbox)
    .where(eq(schema.federationOutbox.peerId, peerId))
    .all().length;
}

function peerByOrigin(origin: string) {
  return testDb.select().from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, origin))
    .get();
}

function countAllOutbox(): number {
  return testDb.select().from(schema.federationOutbox).all().length;
}

function countMutationLog(): number {
  return testDb.select().from(schema.federationMutationLog).all().length;
}

function seedInboundApprovalRequest(origin: string): void {
  testDb.insert(schema.peerApprovalRequests).values({
    id: 'req-1',
    origin,
    direction: 'inbound',
    instanceName: null,
    hmacSecret: 'inbound-secret',
    requestedAt: Date.now(),
    expiresAt: Date.now() + 86_400_000,
    approvalToken: 'token',
  }).run();
}

// Import once at module level — vi.mock is hoisted and the factory returns the
// live testDb reference, so re-using the cached import is correct.
const { queueOutboxEvent, getGroupDmTargetOrigins, queueDmRelay, queueDmMessageDeleteRelay } = await import('./federationOutbox.js');

describe('queueOutboxEvent — non-deliverable statuses', () => {
  beforeEach(() => {
    const sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedSettings();
    // Outbox and mutation-log rows carry snowflake ids; without a worker id the
    // writers swallow the throw and silently persist nothing.
    setWorkerId(1);
    vi.restoreAllMocks();
  });

  it.each([
    ['awaiting_approval'],
    ['needs_attention'],
    ['rejected'],
    ['revoked'],
  ])('drops the event and logs a reason for %s peers (no outbox row, no throw)', (status) => {
    seedPeer('peer-drop', 'https://drop.example', status);

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    queueOutboxEvent('entity-1', 'ctx-1', 'create', '{}', ['https://drop.example'], 'dm');

    expect(countOutbox('peer-drop')).toBe(0);
    expect(debugSpy).toHaveBeenCalled();
    expect(debugSpy.mock.calls[0]![0] as string).toContain(status);
  });
});

describe('DM relay targeting — local-only conversations', () => {
  beforeEach(() => {
    const sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedSettings();
    // Outbox and mutation-log rows carry snowflake ids; without a worker id the
    // writers swallow the throw and silently persist nothing.
    setWorkerId(1);
    vi.restoreAllMocks();
  });

  it('returns no target origins for a DM whose participants are all local', () => {
    seedUser('local-a', null);
    seedUser('local-b', null);
    seedDmChannel('dm-local', ['local-a', 'local-b']);

    expect(getGroupDmTargetOrigins('dm-local')).toEqual([]);
  });

  it('does not queue a local-only DM message for an unrelated peer', () => {
    seedPeer('peer-bystander', 'https://bystander.example', 'active');
    seedUser('local-a', null);
    seedUser('local-b', null);
    seedDmChannel('dm-local', ['local-a', 'local-b']);

    const author = buildAuthor('local-a', null);
    queueDmRelay(buildMessage('msg-1', 'dm-local', author, 'private local text'), 'dm-local', 'create');

    expect(countOutbox('peer-bystander')).toBe(0);
  });

  it('still queues a DM message for the peer that hosts a participant', () => {
    seedPeer('peer-bystander', 'https://bystander.example', 'active');
    seedPeer('peer-remote', 'https://remote.example', 'active');
    seedUser('local-a', null);
    seedUser('remote-b', 'https://remote.example');
    seedDmChannel('dm-mixed', ['local-a', 'remote-b']);

    expect(getGroupDmTargetOrigins('dm-mixed')).toEqual(['https://remote.example']);

    const author = buildAuthor('local-a', null);
    queueDmRelay(buildMessage('msg-2', 'dm-mixed', author, 'federated text'), 'dm-mixed', 'create');

    expect(countOutbox('peer-remote')).toBe(1);
    expect(countOutbox('peer-bystander')).toBe(0);
  });

  it('scopes a message deletion to the peers hosting a participant', () => {
    seedPeer('peer-bystander', 'https://bystander.example', 'active');
    seedPeer('peer-remote', 'https://remote.example', 'active');
    seedUser('local-a', null);
    seedUser('remote-b', 'https://remote.example');
    seedDmChannel('dm-mixed', ['local-a', 'remote-b']);

    queueDmMessageDeleteRelay('msg-4', 'dm-mixed');

    expect(countOutbox('peer-remote')).toBe(1);
    expect(countOutbox('peer-bystander')).toBe(0);
  });

  it('does not relay the deletion of a local-only DM message anywhere', () => {
    seedPeer('peer-bystander', 'https://bystander.example', 'active');
    seedUser('local-a', null);
    seedUser('local-b', null);
    seedDmChannel('dm-local', ['local-a', 'local-b']);

    queueDmMessageDeleteRelay('msg-5', 'dm-local');

    expect(countOutbox('peer-bystander')).toBe(0);
  });

  it('refuses to fan a DM-context event out to every peer when no targets are supplied', () => {
    seedPeer('peer-bystander', 'https://bystander.example', 'active');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    queueOutboxEvent('msg-3', 'dm-local', 'delete', JSON.stringify({ deleted: true }));

    expect(countOutbox('peer-bystander')).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('queueOutboxEvent — placeholder peers and the outbound peering gate', () => {
  function freshDb(autoAccept: 0 | 1): void {
    const sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedSettings(autoAccept);
    setWorkerId(1);
    vi.restoreAllMocks();
  }

  it('creates a pending placeholder for an unknown target origin when auto-accept peering is on', () => {
    // POSITIVE CONTROL for the two suppression cases below: proves this harness
    // observes placeholder creation and outbox writes when they are supposed to
    // happen. Without it, "no row was created" could be vacuously true.
    freshDb(1);

    queueOutboxEvent('entity-a', 'ctx-a', 'create', '{}', ['https://newpeer.example'], 'dm');

    const peer = peerByOrigin('https://newpeer.example');
    expect(peer).toBeTruthy();
    expect(peer?.status).toBe('pending');
    expect(countOutbox(peer!.id)).toBe(1);
  });

  it('tags an outbox-created placeholder with non-admin provenance', () => {
    freshDb(1);

    queueOutboxEvent('entity-a', 'ctx-a', 'create', '{}', ['https://newpeer.example'], 'dm');

    expect(peerByOrigin('https://newpeer.example')?.initiatedBy).toBe('auto');
  });

  it('creates no peer row and no outbox row for an unknown origin when auto-accept peering is off', () => {
    freshDb(0);

    queueOutboxEvent('entity-b', 'ctx-b', 'create', '{}', ['https://attacker.example'], 'dm');

    expect(peerByOrigin('https://attacker.example')).toBeUndefined();
    expect(countAllOutbox()).toBe(0);
  });

  it('creates no peer row while an inbound peering approval request for that origin is unresolved', () => {
    freshDb(1);
    seedInboundApprovalRequest('https://undecided.example');

    queueOutboxEvent('entity-c', 'ctx-c', 'create', '{}', ['https://undecided.example'], 'dm');

    expect(peerByOrigin('https://undecided.example')).toBeUndefined();
    expect(countAllOutbox()).toBe(0);
  });

  it('still delivers to an already-known peer when auto-accept peering is off', () => {
    // POSITIVE CONTROL: the gate must only suppress *creation* of unknown-origin
    // rows, never delivery to peers the admin already approved.
    freshDb(0);
    seedPeer('peer-known', 'https://known.example', 'active');

    queueOutboxEvent('entity-d', 'ctx-d', 'create', '{}', ['https://known.example'], 'dm');

    expect(countOutbox('peer-known')).toBe(1);
  });

  it('records the DM mutation log even when the gate suppresses the placeholder', () => {
    // The mutation log is what replays the conversation once peering is
    // approved later, so suppressing the placeholder must not lose history.
    freshDb(0);
    seedUser('local-a', null);
    seedUser('remote-b', 'https://attacker.example');
    seedDmChannel('dm-mixed', ['local-a', 'remote-b']);

    const author = buildAuthor('local-a', null);
    queueDmRelay(buildMessage('msg-gate', 'dm-mixed', author, 'text'), 'dm-mixed', 'create');

    expect(peerByOrigin('https://attacker.example')).toBeUndefined();
    expect(countAllOutbox()).toBe(0);
    expect(countMutationLog()).toBe(1);
  });
});
