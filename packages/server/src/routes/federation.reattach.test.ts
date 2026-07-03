import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signJwt } from '../utils/auth.js';
import { computeFederatedId } from '../utils/federationOutbox.js';

setWorkerId(13);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock the Task-4 module so the endpoint never touches the network — the
// re-attach flow's only outbound calls (proof verification + profile fetch)
// go through these two functions.
const verifyMock = vi.fn();
const profileMock = vi.fn();
vi.mock('../utils/federationAttach.js', () => ({
  verifyAttachProofWithPeer: (...args: unknown[]) => verifyMock(...args),
  fetchHomeProfileByHomeId: (...args: unknown[]) => profileMock(...args),
}));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

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

async function buildApp(): Promise<FastifyInstance> {
  const { federationRoutes } = await import('./federation.js');
  const f = Fastify();
  await f.register(federationRoutes);
  return f;
}

async function reattach(userId: string, username: string, token = 'a'.repeat(64)) {
  return app.inject({
    method: 'POST',
    url: '/api/users/@me/reattach',
    headers: { authorization: `Bearer ${signJwt({ userId, username })}` },
    payload: { token },
  });
}

beforeEach(async () => {
  verifyMock.mockReset();
  profileMock.mockReset();

  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  // Peer row for the home domain (orbit), ACTIVE.
  testDb.insert(schema.federationPeers).values({
    id: 'peer-1', origin: 'https://orbit.test', hmacSecret: 's'.repeat(64), status: 'active', createdAt: 1,
  }).run();
  // The detached account (session user) — old identity dead-home-1.
  testDb.insert(schema.users).values({
    id: 'detached-1', username: 'youruser@orbit.test', passwordHash: 'local-hash',
    homeInstance: 'orbit.test', homeUserId: 'dead-home-1', federationHomeOrphaned: 1,
    avatarColor: 'coral', createdAt: 1,
  }).run();
  // A native friend for broadcast/merge fixtures.
  testDb.insert(schema.users).values({
    id: 'alice', username: 'alice', passwordHash: 'x', homeInstance: null, createdAt: 1,
  }).run();

  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/users/@me/reattach — guards', () => {
  it('403 for a non-detached account', async () => {
    testDb.update(schema.users).set({ federationHomeOrphaned: 0 }).where(eq(schema.users.id, 'detached-1')).run();
    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(403);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('403 for a native account', async () => {
    const res = await reattach('alice', 'alice');
    expect(res.statusCode).toBe(403);
  });

  it('rejects a tombstoned session before any re-attach work (authenticate gate)', async () => {
    // Detached tombstones are not re-attachable (spec §2). `authenticate` 401s a
    // deleted account before the handler runs; the handler's own is_deleted 404
    // remains as defense-in-depth for a concurrent-delete race. Either way the
    // proof exchange never happens.
    testDb.update(schema.users).set({ isDeleted: 1 }).where(eq(schema.users.id, 'detached-1')).run();
    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(401);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('409 when the home peer is not active', async () => {
    testDb.update(schema.federationPeers).set({ status: 'unreachable' }).where(eq(schema.federationPeers.id, 'peer-1')).run();
    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(409);
  });

  it('400 when the token is not 64-char hex', async () => {
    const res = await reattach('detached-1', 'youruser@orbit.test', 'not-hex');
    expect(res.statusCode).toBe(400);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('401 when the proof does not verify', async () => {
    verifyMock.mockResolvedValue({ valid: false });
    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(401);
    // Nothing changed.
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'detached-1')).get()!;
    expect(row.federationHomeOrphaned).toBe(1);
    expect(row.homeUserId).toBe('dead-home-1');
  });
});

describe('POST /api/users/@me/reattach — success', () => {
  beforeEach(() => {
    verifyMock.mockResolvedValue({ valid: true, homeUserId: 'new-home-1', username: 'youruser' });
    profileMock.mockResolvedValue({
      username: 'youruser',
      profile: { displayName: 'Jannis', avatar: null, avatarColor: 'lavender', banner: null, bio: null },
    });
  });

  it('re-binds identity, clears the flag, applies the home profile', async () => {
    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'detached-1')).get()!;
    expect(row.homeUserId).toBe('new-home-1');
    expect(row.federationHomeOrphaned).toBe(0);
    expect(row.displayName).toBe('Jannis');
    expect(row.avatarColor).toBe('lavender');
    expect(row.profileUpdatedAt).toBeNull(); // next profile_update always applies
    expect(row.username).toBe('youruser@orbit.test'); // same base → no rename
  });

  it('renames when the new home username base differs (collision-suffix scheme)', async () => {
    verifyMock.mockResolvedValue({ valid: true, homeUserId: 'new-home-1', username: 'hans' });
    testDb.insert(schema.users).values({
      id: 'squatter', username: 'hans@orbit.test', passwordHash: '!federation-replicated',
      homeInstance: 'orbit.test', homeUserId: 'other', createdAt: 1,
    }).run();
    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(200);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'detached-1')).get()!;
    expect(row.username).toBe('hans_1@orbit.test');
  });

  it('proceeds without a profile when the home profile fetch fails', async () => {
    profileMock.mockResolvedValue(null);
    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(200);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'detached-1')).get()!;
    expect(row.homeUserId).toBe('new-home-1');
    expect(row.avatarColor).toBe('coral'); // untouched
  });

  it('subsequent S2S profile_update APPLIES after re-attach (guard no longer fires)', async () => {
    await reattach('detached-1', 'youruser@orbit.test');
    const { processProfileUpdateEvent } = await import('./federation.js');
    const accepted: string[] = [];
    const rejected: Array<{ messageId: string; reason: string }> = [];
    await processProfileUpdateEvent({
      eventType: 'profile_update', contextType: 'profile', messageId: 'pu-1',
      encryptionVersion: 0, timestamp: Date.now(),
      profileUpdate: {
        homeUserId: 'new-home-1', homeInstance: 'https://orbit.test',
        profileUpdatedAt: Date.now(), username: 'youruser',
        displayName: 'NewName', avatar: null, banner: null,
        accentColor: null, avatarColor: 'mint', bio: null,
      },
    } as Parameters<typeof processProfileUpdateEvent>[0], 'https://orbit.test', testDb, accepted, rejected);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'detached-1')).get()!;
    expect(row.displayName).toBe('NewName');
    expect(row.avatarColor).toBe('mint');
  });
});

describe('POST /api/users/@me/reattach — stub merge', () => {
  beforeEach(() => {
    verifyMock.mockResolvedValue({ valid: true, homeUserId: 'new-home-1', username: 'youruser' });
    profileMock.mockResolvedValue(null);
    // Stub for the NEW identity, created earlier by ordinary relay.
    testDb.insert(schema.users).values({
      id: 'stub-new', username: 'youruser_1@orbit.test', passwordHash: '!federation-replicated',
      homeInstance: 'orbit.test', homeUserId: 'new-home-1', createdAt: 2,
    }).run();
    // Stub state: a DM with alice (which the detached row is ALSO in → dedupe),
    // a message, a friendship with alice (detached row also friends → dedupe).
    testDb.insert(schema.dmChannels).values({ id: 'ch-1', federatedId: 'fed-1', createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'ch-1', userId: 'alice', closed: 0 },
      { dmChannelId: 'ch-1', userId: 'detached-1', closed: 0 },
      { dmChannelId: 'ch-1', userId: 'stub-new', closed: 0 },
    ]).run();
    testDb.insert(schema.dmMessages).values({
      id: 'm-stub', dmChannelId: 'ch-1', userId: 'stub-new', content: 'from new incarnation', createdAt: 3,
    }).run();
    // An attachment the stub uploaded onto its DM message — uploader_id is a
    // plain text column (no FK), so it must be repointed explicitly or attribution
    // dangles at the deleted stub's id.
    testDb.insert(schema.attachments).values({
      id: 'att-stub', dmMessageId: 'm-stub', uploaderId: 'stub-new',
      filename: 'f.webp', originalName: 'f.webp', mimetype: 'image/webp', size: 100, createdAt: 3,
    }).run();
    testDb.insert(schema.friends).values([
      { userId: 'alice', friendId: 'detached-1', createdAt: 1 },
      { userId: 'alice', friendId: 'stub-new', createdAt: 2 },
    ]).run();
  });

  it('merges the stub into the detached row: repointed, deduped, deleted', async () => {
    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(200);
    // Stub gone.
    expect(testDb.select().from(schema.users).all().some(u => u.id === 'stub-new')).toBe(false);
    // Message repointed.
    const msg = testDb.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, 'm-stub')).get()!;
    expect(msg.userId).toBe('detached-1');
    // Attachment attribution repointed off the deleted stub.
    const att = testDb.select().from(schema.attachments).where(eq(schema.attachments.id, 'att-stub')).get()!;
    expect(att.uploaderId).toBe('detached-1');
    // Membership deduped (detached row already a member).
    const members = testDb.select().from(schema.dmMembers).all().filter(m => m.dmChannelId === 'ch-1');
    expect(members.map(m => m.userId).sort()).toEqual(['alice', 'detached-1']);
    // Friendship deduped.
    const friendRows = testDb.select().from(schema.friends).all();
    expect(friendRows).toHaveLength(1);
    expect(friendRows[0]!.friendId).toBe('detached-1');
  });

  it('409 when the new identity is held by a REAL account (not a stub)', async () => {
    testDb.update(schema.users).set({ passwordHash: 'real-hash' }).where(eq(schema.users.id, 'stub-new')).run();
    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(409);
    // Nothing changed on the detached row.
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'detached-1')).get()!;
    expect(row.homeUserId).toBe('dead-home-1');
  });
});

describe('POST /api/users/@me/reattach — 1-on-1 DM channel reconciliation', () => {
  beforeEach(() => {
    verifyMock.mockResolvedValue({ valid: true, homeUserId: 'new-home-1', username: 'youruser' });
    profileMock.mockResolvedValue(null);
    // 'alice' is R-native; she has a DM with the detached account under the OLD
    // pairing, and a fresh DM under the NEW pairing (created by post-reset relay).
  });

  it('merges the pre-reattach history channel into the new-identity channel', async () => {
    const oldFed = computeFederatedId('alice', 'dead-home-1'); // alice home = her id (native)
    const newFed = computeFederatedId('alice', 'new-home-1');
    // history channel (old id)
    testDb.insert(schema.dmChannels).values({ id: 'ch-old', federatedId: oldFed, createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'ch-old', userId: 'alice', closed: 0 },
      { dmChannelId: 'ch-old', userId: 'detached-1', closed: 0 },
    ]).run();
    testDb.insert(schema.dmMessages).values([
      { id: 'mo1', dmChannelId: 'ch-old', userId: 'alice', content: 'old1', createdAt: 100 },
      { id: 'mo2', dmChannelId: 'ch-old', userId: 'detached-1', content: 'old2', createdAt: 110 },
    ]).run();
    // fresh channel (new id)
    testDb.insert(schema.dmChannels).values({ id: 'ch-new', federatedId: newFed, createdAt: 2 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'ch-new', userId: 'alice', closed: 0 },
      { dmChannelId: 'ch-new', userId: 'detached-1', closed: 0 },
    ]).run();
    testDb.insert(schema.dmMessages).values({ id: 'mn1', dmChannelId: 'ch-new', userId: 'detached-1', content: 'new1', createdAt: 200 }).run();

    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(200);
    // old channel gone; all history now under ch-new, in order.
    expect(testDb.select().from(schema.dmChannels).all().some(c => c.id === 'ch-old')).toBe(false);
    const msgs = testDb.select().from(schema.dmMessages).all().filter(m => m.dmChannelId === 'ch-new').sort((a, b) => a.createdAt - b.createdAt);
    expect(msgs.map(m => m.id)).toEqual(['mo1', 'mo2', 'mn1']);
  });

  it('re-keys the history channel in place when no new-identity channel exists yet', async () => {
    const oldFed = computeFederatedId('alice', 'dead-home-1');
    testDb.insert(schema.dmChannels).values({ id: 'ch-old', federatedId: oldFed, createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'ch-old', userId: 'alice', closed: 0 },
      { dmChannelId: 'ch-old', userId: 'detached-1', closed: 0 },
    ]).run();
    testDb.insert(schema.dmMessages).values({ id: 'mo1', dmChannelId: 'ch-old', userId: 'alice', content: 'x', createdAt: 100 }).run();

    const res = await reattach('detached-1', 'youruser@orbit.test');
    expect(res.statusCode).toBe(200);
    const ch = testDb.select().from(schema.dmChannels).all().find(c => c.id === 'ch-old')!;
    expect(ch.federatedId).toBe(computeFederatedId('alice', 'new-home-1'));
  });
});
