import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'owner-A';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    getRoom: () => undefined,
    getUserRoom: () => undefined,
    leaveCurrentRoom: vi.fn(() => false),
    destroyRoom: vi.fn(),
    clearVoiceUserStatus: vi.fn(),
  },
}));

// Federation: keep the real outbox writers (queueOutboxEvent / appendMutationLog)
// so we can read federation_outbox rows directly to assert the wire payload.
// Same-module callers inside helpers bypass vi.mock — inspect the persisted
// row instead. Unrelated queue helpers are stubbed because they aren't under
// test here.
vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    isFederationRelayEnabled: () => true,
    queueDmCloseRelay: vi.fn(),
    sendTypingRelay: vi.fn(),
    queueDmRelay: vi.fn(),
    queueGroupMetadataRelay: vi.fn(),
  };
});

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://local.test' };
});

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
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sqlText.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUsers(): void {
  testDb.insert(schema.users).values({
    id: 'owner-A',
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'x',
    homeUserId: 'owner-A',
    homeInstance: 'https://local.test',
    createdAt: Date.now(),
  }).run();

  testDb.insert(schema.users).values({
    id: 'member-B',
    username: 'bob',
    displayName: 'Bob',
    passwordHash: 'x',
    homeUserId: 'member-B',
    homeInstance: 'https://local.test',
    createdAt: Date.now(),
  }).run();

  testDb.insert(schema.users).values({
    id: 'member-C',
    username: 'carol',
    displayName: 'Carol',
    passwordHash: 'x',
    homeUserId: 'member-C',
    homeInstance: 'https://local.test',
    createdAt: Date.now(),
  }).run();

  testDb.insert(schema.users).values({
    id: 'remote-D',
    username: 'dan@remote.test',
    displayName: 'Dan',
    passwordHash: 'x',
    homeUserId: 'remote-dan',
    homeInstance: 'https://remote.test',
    createdAt: Date.now(),
  }).run();
}

function seedInstanceSettings(): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    federationRelayEnabled: 1,
    updatedAt: Date.now(),
  }).run();
}

function seedFederationPeer(origin: string): void {
  testDb.insert(schema.federationPeers).values({
    id: `peer-${origin}`,
    origin,
    status: 'active',
    hmacSecret: 'x',
    createdAt: Date.now(),
  }).run();
}

interface GroupSeed {
  id: string;
  ownerId: string;
  members: string[];
  federatedId?: string | null;
  ownerHomeUserId?: string | null;
  ownerHomeInstance?: string | null;
}

function seedGroupDm(opts: GroupSeed): void {
  testDb.insert(schema.dmChannels).values({
    id: opts.id,
    ownerId: opts.ownerId,
    ownerHomeUserId: opts.ownerHomeUserId ?? opts.ownerId,
    ownerHomeInstance: opts.ownerHomeInstance ?? 'https://local.test',
    federatedId: opts.federatedId ?? null,
    createdAt: Date.now(),
  }).run();
  for (const userId of opts.members) {
    testDb.insert(schema.dmMembers).values({
      dmChannelId: opts.id,
      userId,
    }).run();
  }
}

function seed1on1Dm(id: string, a: string, b: string): void {
  testDb.insert(schema.dmChannels).values({
    id,
    ownerId: null,
    createdAt: Date.now(),
  }).run();
  testDb.insert(schema.dmMembers).values({ dmChannelId: id, userId: a }).run();
  testDb.insert(schema.dmMembers).values({ dmChannelId: id, userId: b }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { dmRoutes } = await import('./dm.js');
  await app.register(dmRoutes);
  await app.ready();
  return app;
}

describe('POST /api/dm/:id/transfer — manual ownership transfer', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    seedUsers();
    seedFederationPeer('https://remote.test');
    currentUserId = 'owner-A';
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('owner transfers to a local member → 200, ownership row mutated, broadcast emitted, system message inserted, outbox queued', async () => {
    seedGroupDm({
      id: 'dm-1',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B', 'remote-D'],
      federatedId: 'fed-transfer-1',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-1/transfer',
      payload: { newOwnerId: 'member-B' },
    });
    expect(res.statusCode).toBe(200);

    // Channel ownership row updated to new owner's identity
    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm-1')).get();
    expect(channel?.ownerId).toBe('member-B');
    expect(channel?.ownerHomeUserId).toBe('member-B');
    expect(channel?.ownerHomeInstance).toBe('https://local.test');

    // owner_changed system message present with new owner display info
    const sysRows = testDb.select().from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, 'dm-1'))
      .all();
    const ownerChangedRow = sysRows.find((r) => {
      try {
        return JSON.parse(r.content!).event === 'owner_changed';
      } catch {
        return false;
      }
    });
    expect(ownerChangedRow).toBeDefined();
    expect(ownerChangedRow!.type).toBe('system');
    // System message is authored by the previous owner (the actor of the transfer)
    expect(ownerChangedRow!.userId).toBe('owner-A');
    const parsed = JSON.parse(ownerChangedRow!.content!);
    expect(parsed.event).toBe('owner_changed');
    expect(parsed.newOwnerId).toBe('member-B');
    expect(parsed.newOwnerDisplayName).toBe('Bob');

    // dm_owner_updated broadcast fired for all current members
    const sendCalls = (connectionManager.sendToUser as ReturnType<typeof vi.fn>).mock.calls;
    const ownerUpdatedBroadcasts = sendCalls.filter((c) =>
      c[1]?.type === 'dm_owner_updated' &&
      c[1]?.dmChannelId === 'dm-1' &&
      c[1]?.newOwnerId === 'member-B'
    );
    const recipients = new Set(ownerUpdatedBroadcasts.map((c) => c[0]));
    expect(recipients.has('owner-A')).toBe(true);
    expect(recipients.has('member-B')).toBe(true);
    expect(recipients.has('remote-D')).toBe(true);

    // Federation outbox queued with correct ownership_transfer payload
    const outboxRows = testDb.select().from(schema.federationOutbox).all();
    const transferRows = outboxRows.filter((r) => r.eventType === 'ownership_transfer');
    expect(transferRows.length).toBe(1);
    const wire = JSON.parse(transferRows[0]!.payload);
    expect(wire.eventType).toBe('ownership_transfer');
    expect(wire.federatedId).toBe('fed-transfer-1');
    expect(wire.ownership.newOwner.homeUserId).toBe('member-B');
    expect(wire.ownership.newOwner.homeInstance).toBe('https://local.test');
    expect(wire.ownership.previousOwner.homeUserId).toBe('owner-A');
    expect(wire.ownership.previousOwner.homeInstance).toBe('https://local.test');
  });

  it('non-owner attempts transfer → 403', async () => {
    seedGroupDm({
      id: 'dm-2',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B', 'member-C'],
    });
    currentUserId = 'member-B';

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-2/transfer',
      payload: { newOwnerId: 'member-C' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/owner/i);

    // Ownership row unchanged
    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm-2')).get();
    expect(channel?.ownerId).toBe('owner-A');
  });

  it('self-transfer (newOwnerId === ownerId) → 400', async () => {
    seedGroupDm({
      id: 'dm-3',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B'],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-3/transfer',
      payload: { newOwnerId: 'owner-A' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/current owner/i);

    // Ownership row unchanged
    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm-3')).get();
    expect(channel?.ownerId).toBe('owner-A');
  });

  it('transfer to non-member → 400', async () => {
    seedGroupDm({
      id: 'dm-4',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B'],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-4/transfer',
      payload: { newOwnerId: 'member-C' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a member/i);

    // Ownership row unchanged
    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm-4')).get();
    expect(channel?.ownerId).toBe('owner-A');
  });

  it('transfer with newOwnerId referencing a federated member → ownership fields carry that user homeUserId/homeInstance correctly', async () => {
    seedGroupDm({
      id: 'dm-5',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B', 'remote-D'],
      federatedId: 'fed-transfer-5',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-5/transfer',
      payload: { newOwnerId: 'remote-D' },
    });
    expect(res.statusCode).toBe(200);

    // Channel ownership row carries the remote user's home identity
    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm-5')).get();
    expect(channel?.ownerId).toBe('remote-D');
    expect(channel?.ownerHomeUserId).toBe('remote-dan');
    expect(channel?.ownerHomeInstance).toBe('https://remote.test');

    // Federation outbox newOwner identity matches the remote user's home
    const outboxRows = testDb.select().from(schema.federationOutbox).all();
    const transferRows = outboxRows.filter((r) => r.eventType === 'ownership_transfer');
    expect(transferRows.length).toBe(1);
    const wire = JSON.parse(transferRows[0]!.payload);
    expect(wire.ownership.newOwner.homeUserId).toBe('remote-dan');
    expect(wire.ownership.newOwner.homeInstance).toBe('https://remote.test');
    expect(wire.ownership.previousOwner.homeUserId).toBe('owner-A');
    expect(wire.ownership.previousOwner.homeInstance).toBe('https://local.test');
  });

  it('transfer in a 1-on-1 DM → 400', async () => {
    seed1on1Dm('dm-1on1', 'owner-A', 'member-B');

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-1on1/transfer',
      payload: { newOwnerId: 'member-B' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/1-on-1/i);
  });

  it('transfer on non-existent channel → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/does-not-exist/transfer',
      payload: { newOwnerId: 'member-B' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('transfer with missing newOwnerId body → 400', async () => {
    seedGroupDm({
      id: 'dm-6',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B'],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/dm-6/transfer',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/newOwnerId/i);
  });
});
