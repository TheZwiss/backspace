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
}

function seedGroupDm(opts: GroupSeed): void {
  testDb.insert(schema.dmChannels).values({
    id: opts.id,
    ownerId: opts.ownerId,
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

describe('DELETE /api/dm/:id/members/:targetUserId — owner kick', () => {
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

  it('owner kicks a member → 200, member row gone, system message + dm_member_removed broadcast + federation outbox queued with reason=kick', async () => {
    seedGroupDm({
      id: 'dm-1',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B', 'remote-D'],
      federatedId: 'fed-kick-1',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/dm/dm-1/members/member-B',
    });
    expect(res.statusCode).toBe(200);

    // dm_members row for kicked target is gone
    const remainingMembers = testDb.select().from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, 'dm-1'))
      .all();
    expect(remainingMembers.map((m) => m.userId).sort()).toEqual(['owner-A', 'remote-D']);

    // member_removed system message present with reason=kick
    const sysRows = testDb.select().from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, 'dm-1'))
      .all();
    const memberRemovedRow = sysRows.find((r) => {
      try {
        return JSON.parse(r.content!).event === 'member_removed';
      } catch {
        return false;
      }
    });
    expect(memberRemovedRow).toBeDefined();
    expect(memberRemovedRow!.type).toBe('system');
    const parsed = JSON.parse(memberRemovedRow!.content!);
    expect(parsed.event).toBe('member_removed');
    expect(parsed.reason).toBe('kick');
    expect(parsed.targetUserId).toBe('member-B');

    // dm_member_removed broadcast fired for remaining members
    const sendCalls = (connectionManager.sendToUser as ReturnType<typeof vi.fn>).mock.calls;
    const removedBroadcasts = sendCalls.filter((c) =>
      c[1]?.type === 'dm_member_removed' &&
      c[1]?.dmChannelId === 'dm-1' &&
      c[1]?.userId === 'member-B'
    );
    // Sent to each remaining member (owner-A + remote-D = 2) — ownership transfer doesn't fire on kick
    expect(removedBroadcasts.length).toBeGreaterThanOrEqual(1);
    const recipients = new Set(removedBroadcasts.map((c) => c[0]));
    expect(recipients.has('owner-A')).toBe(true);
    expect(recipients.has('remote-D')).toBe(true);

    // Federation outbox queued with reason=kick + correct identities
    const outboxRows = testDb.select().from(schema.federationOutbox).all();
    const memberRemoveRows = outboxRows.filter((r) => r.eventType === 'member_remove');
    expect(memberRemoveRows.length).toBe(1);
    const wire = JSON.parse(memberRemoveRows[0]!.payload);
    expect(wire.eventType).toBe('member_remove');
    expect(wire.federatedId).toBe('fed-kick-1');
    expect(wire.membership.reason).toBe('kick');
    expect(wire.membership.user.homeUserId).toBe('member-B');
    expect(wire.membership.user.homeInstance).toBe('https://local.test');
    expect(wire.membership.removedBy.homeUserId).toBe('owner-A');
    expect(wire.membership.removedBy.homeInstance).toBe('https://local.test');

    // Channel is NOT soft-deleted (kick never orphans the group)
    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm-1')).get();
    expect(channel?.deletedAt).toBeNull();

    // Owner unchanged (kick does not transfer ownership)
    expect(channel?.ownerId).toBe('owner-A');

    // No ownership_transfer outbox row queued
    const transferRows = outboxRows.filter((r) => r.eventType === 'ownership_transfer');
    expect(transferRows.length).toBe(0);
  });

  it('non-owner kick attempt → 403', async () => {
    seedGroupDm({
      id: 'dm-2',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B', 'member-C'],
    });
    currentUserId = 'member-B';

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/dm/dm-2/members/member-C',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/owner/i);

    // Target still a member
    const stillMember = testDb.select().from(schema.dmMembers).where(eq(schema.dmMembers.userId, 'member-C')).get();
    expect(stillMember).toBeDefined();
  });

  it('owner attempts to kick self → 400 with "use leave instead" message', async () => {
    seedGroupDm({
      id: 'dm-3',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B'],
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/dm/dm-3/members/owner-A',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/leave instead/i);

    // Owner still a member, channel unchanged
    const stillOwner = testDb.select().from(schema.dmMembers).where(eq(schema.dmMembers.userId, 'owner-A')).get();
    expect(stillOwner).toBeDefined();
  });

  it('kick from a 1-on-1 DM → 400', async () => {
    seed1on1Dm('dm-1on1', 'owner-A', 'member-B');

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/dm/dm-1on1/members/member-B',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/1-on-1/i);
  });

  it('target is not a member of the group → 404', async () => {
    seedGroupDm({
      id: 'dm-4',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B'],
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/dm/dm-4/members/member-C',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not a member/i);
  });

  it('kick from a non-existent channel → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/dm/does-not-exist/members/member-B',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  // Federated-identification path — mirrors POST /api/dm/:id/transfer. The
  // client cannot reliably know the OWNER instance's local user id for a
  // federated member (the home view surfaced through `useCanonicalUserView`
  // carries the home id). The `?homeInstance=...` query string signals the
  // path segment is a homeUserId; the server resolves via
  // `resolveOrCreateReplicatedUser` before checking membership.
  it('kick with federated identity (?homeInstance=...) → resolves to local replicated user and succeeds', async () => {
    seedGroupDm({
      id: 'dm-kick-fed-1',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B', 'remote-D'],
      federatedId: 'fed-kick-fed-1',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/dm/dm-kick-fed-1/members/remote-dan?homeInstance=' + encodeURIComponent('https://remote.test'),
    });
    expect(res.statusCode).toBe(200);

    // Federated member's local replicated row is gone from this channel
    const remaining = testDb.select().from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, 'dm-kick-fed-1'))
      .all();
    expect(remaining.map((m) => m.userId).sort()).toEqual(['member-B', 'owner-A']);

    // Outbox event carries the federated user's home identity with reason=kick
    const outboxRows = testDb.select().from(schema.federationOutbox).all();
    const removeRows = outboxRows.filter((r) => r.eventType === 'member_remove');
    expect(removeRows.length).toBe(1);
    const wire = JSON.parse(removeRows[0]!.payload);
    expect(wire.membership.reason).toBe('kick');
    expect(wire.membership.user.homeUserId).toBe('remote-dan');
    expect(wire.membership.user.homeInstance).toBe('https://remote.test');
  });

  // Negative case: federated identity for a user who is NOT a member.
  it('kick with federated identity for non-member → 404', async () => {
    seedGroupDm({
      id: 'dm-kick-fed-2',
      ownerId: 'owner-A',
      members: ['owner-A', 'member-B'], // remote-D is NOT a member here
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/dm/dm-kick-fed-2/members/remote-dan?homeInstance=' + encodeURIComponent('https://remote.test'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not a member/i);
  });
});
