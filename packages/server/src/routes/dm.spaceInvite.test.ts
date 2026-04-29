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

// Module-level mutable state. The vi.mock factories below close over these
// bindings via getter functions, so reassignment in beforeEach is observed.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'alice';

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
  },
}));

vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    isFederationRelayEnabled: () => false,
    queueDmCloseRelay: vi.fn(),
    sendTypingRelay: vi.fn(),
    queueDmRelay: vi.fn(),
    queueOutboxEvent: vi.fn(),
    appendMutationLog: vi.fn(),
  };
});

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://local.test' };
});

// Mock the snapshot helpers so tests don't make real HTTP calls and we can
// observe which lookup path the route takes (local DB vs. cross-instance HTTP).
vi.mock('../utils/spaceInviteSnapshot.js', () => ({
  fetchSpaceInviteSnapshot: vi.fn(),
  getLocalInviteSnapshot: vi.fn(),
}));
import { fetchSpaceInviteSnapshot, getLocalInviteSnapshot } from '../utils/spaceInviteSnapshot.js';

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sqlText.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

interface UserSeed {
  id: string;
  username: string;
  displayName?: string | null;
}

function seedUser(u: UserSeed): void {
  testDb.insert(schema.users).values({
    id: u.id,
    username: u.username,
    displayName: u.displayName ?? null,
    passwordHash: 'x',
    status: 'offline',
    isAdmin: 0,
    isDeleted: 0,
    discoverable: 1,
    homeInstance: null,
    homeUserId: null,
    createdAt: Date.now(),
  }).run();
}

function seedFriendship(a: string, b: string): void {
  // The endpoint's friendship check looks at either ordering of (userId, friendId),
  // so a single row is sufficient.
  testDb.insert(schema.friends).values({
    userId: a,
    friendId: b,
    createdAt: Date.now(),
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { dmRoutes } = await import('./dm.js');
  await app.register(dmRoutes);
  await app.ready();
  return app;
}

describe('POST /api/dm/space-invite', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedUser({ id: 'alice', username: 'alice' });
    seedUser({ id: 'bob', username: 'bob' });
    seedFriendship('alice', 'bob');
    currentUserId = 'alice';
    (fetchSpaceInviteSnapshot as unknown as ReturnType<typeof vi.fn>).mockReset();
    (getLocalInviteSnapshot as unknown as ReturnType<typeof vi.fn>).mockReset();
    app = await buildApp();
  });

  it('rejects 400 not_a_friend if target is not a friend', async () => {
    seedUser({ id: 'charlie', username: 'charlie' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/space-invite',
      payload: {
        target: { userId: 'charlie' },
        spaceId: 'S1',
        spaceInstanceOrigin: '',
        inviteCode: 'abc123',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('not_a_friend');
    // Snapshot should not be looked up if friendship gate fails first.
    expect(fetchSpaceInviteSnapshot).not.toHaveBeenCalled();
    expect(getLocalInviteSnapshot).not.toHaveBeenCalled();
  });

  it('rejects 400 invite_invalid when local snapshot lookup returns null', async () => {
    (getLocalInviteSnapshot as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/space-invite',
      payload: {
        target: { userId: 'bob' },
        spaceId: 'S1',
        spaceInstanceOrigin: '',
        inviteCode: 'badcode',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invite_invalid');
    // No DM message should be inserted on failure.
    const messageCount = testDb.select().from(schema.dmMessages).all().length;
    expect(messageCount).toBe(0);
  });

  it('rejects 400 invite_invalid when snapshot.spaceId mismatches the requested spaceId', async () => {
    (getLocalInviteSnapshot as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      spaceId: 'WRONG',
      spaceName: 'X',
      description: null,
      icon: null,
      avatarColor: null,
      memberCount: 1,
      instanceName: 'Backspace',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/space-invite',
      payload: {
        target: { userId: 'bob' },
        spaceId: 'S1',
        spaceInstanceOrigin: '',
        inviteCode: 'abc',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invite_invalid');
    const messageCount = testDb.select().from(schema.dmMessages).all().length;
    expect(messageCount).toBe(0);
  });

  it('inserts a type=system message with parseable space_invite content on success', async () => {
    (getLocalInviteSnapshot as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      spaceId: 'S1',
      spaceName: 'Aether',
      description: 'desc',
      icon: null,
      avatarColor: 'mint',
      memberCount: 12,
      instanceName: 'Backspace',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/space-invite',
      payload: {
        target: { userId: 'bob' },
        spaceId: 'S1',
        spaceInstanceOrigin: '',
        inviteCode: 'abc',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      dmChannelId: string;
      messageId: string;
      message: { type: string };
    };
    expect(body.dmChannelId).toBeTruthy();
    expect(body.messageId).toBeTruthy();
    expect(body.message.type).toBe('system');

    const stored = testDb.select()
      .from(schema.dmMessages)
      .where(eq(schema.dmMessages.id, body.messageId))
      .get();
    expect(stored).toBeTruthy();
    expect(stored?.type).toBe('system');
    expect(stored?.userId).toBe('alice');
    expect(stored?.dmChannelId).toBe(body.dmChannelId);

    const parsed = JSON.parse(stored!.content!);
    expect(parsed.event).toBe('space_invite');
    expect(parsed.spaceId).toBe('S1');
    expect(parsed.inviteCode).toBe('abc');
    expect(parsed.snapshot.spaceName).toBe('Aether');
    expect(parsed.snapshot.memberCount).toBe(12);
    expect(parsed.snapshot.avatarColor).toBe('mint');
    expect(parsed.snapshot.description).toBe('desc');
    expect(parsed.snapshot.instanceName).toBe('Backspace');
  });

  it('reuses an existing 1-on-1 DM rather than creating a new one', async () => {
    (getLocalInviteSnapshot as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      spaceId: 'S1',
      spaceName: 'Aether',
      description: null,
      icon: null,
      avatarColor: null,
      memberCount: 1,
      instanceName: 'Backspace',
    });

    const r1 = await app.inject({
      method: 'POST',
      url: '/api/dm/space-invite',
      payload: {
        target: { userId: 'bob' },
        spaceId: 'S1',
        spaceInstanceOrigin: '',
        inviteCode: 'abc',
      },
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/dm/space-invite',
      payload: {
        target: { userId: 'bob' },
        spaceId: 'S1',
        spaceInstanceOrigin: '',
        inviteCode: 'abc',
      },
    });
    expect(r2.statusCode).toBe(200);

    const body1 = JSON.parse(r1.body) as { dmChannelId: string; messageId: string };
    const body2 = JSON.parse(r2.body) as { dmChannelId: string; messageId: string };
    expect(body2.dmChannelId).toBe(body1.dmChannelId);
    expect(body2.messageId).not.toBe(body1.messageId);

    // Exactly one DM channel exists between alice and bob.
    const channels = testDb.select().from(schema.dmChannels).all();
    expect(channels.length).toBe(1);
    // Two system messages were inserted into that single channel.
    const messages = testDb.select()
      .from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, body1.dmChannelId))
      .all();
    expect(messages.length).toBe(2);
    expect(messages.every(m => m.type === 'system')).toBe(true);
  });

  it('uses local DB lookup (skips HTTP) when spaceInstanceOrigin is empty/local', async () => {
    // Regression guard for the production hang: when the space is local, the
    // route MUST NOT call fetchSpaceInviteSnapshot — that path tries to reach
    // our own public domain over HTTPS, which fails inside Docker (NAT loopback).
    (getLocalInviteSnapshot as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      spaceId: 'S1',
      spaceName: 'Aether',
      description: null,
      icon: null,
      avatarColor: null,
      memberCount: 1,
      instanceName: 'Backspace',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/space-invite',
      payload: {
        target: { userId: 'bob' },
        spaceId: 'S1',
        spaceInstanceOrigin: '',
        inviteCode: 'abc',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(getLocalInviteSnapshot).toHaveBeenCalledWith('abc');
    // CRITICAL: the HTTP fetch path must NOT run for local invites.
    expect(fetchSpaceInviteSnapshot).not.toHaveBeenCalled();
  });

  it('uses local DB lookup when spaceInstanceOrigin equals our own origin', async () => {
    // Same fast-path applies if the client sends our origin explicitly.
    (getLocalInviteSnapshot as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      spaceId: 'S1',
      spaceName: 'Aether',
      description: null,
      icon: null,
      avatarColor: null,
      memberCount: 1,
      instanceName: 'Backspace',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/space-invite',
      payload: {
        target: { userId: 'bob' },
        spaceId: 'S1',
        spaceInstanceOrigin: 'https://local.test',
        inviteCode: 'abc',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(getLocalInviteSnapshot).toHaveBeenCalledWith('abc');
    expect(fetchSpaceInviteSnapshot).not.toHaveBeenCalled();
  });

  it('uses HTTP fetch path for cross-instance invites', async () => {
    // Regression guard: when the space is on a different instance, we must
    // hit the SSRF-validated HTTP path, not the local DB.
    (fetchSpaceInviteSnapshot as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      spaceId: 'S1',
      spaceName: 'Remote',
      description: null,
      icon: null,
      avatarColor: null,
      memberCount: 5,
      instanceName: 'OtherHost',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/dm/space-invite',
      payload: {
        target: { userId: 'bob' },
        spaceId: 'S1',
        spaceInstanceOrigin: 'https://remote.example',
        inviteCode: 'abc',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchSpaceInviteSnapshot).toHaveBeenCalledWith('https://remote.example', 'abc');
    expect(getLocalInviteSnapshot).not.toHaveBeenCalled();
  });
});
