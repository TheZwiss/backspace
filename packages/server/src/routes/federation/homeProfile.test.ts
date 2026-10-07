import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { setWorkerId } from '../../utils/snowflake.js';
import type { LookupResult } from '../../utils/federationLookup.js';

// Downloaded profile images land in a throwaway directory, set before
// config.ts is first imported.
const UPLOAD_DIR = await vi.hoisted(async () => {
  const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
  const dir = mkdtempSync(join(tmpdir(), 'bs-home-profile-'));
  process.env.UPLOAD_DIR = dir;
  return dir;
});

setWorkerId(21);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

const sendToUser = vi.fn();
vi.mock('../../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: (...args: unknown[]) => sendToUser(...args),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    evictFederatedCallsForHost: vi.fn(),
    dropRemoteCallParticipants: vi.fn().mockReturnValue(0),
    federatedCalls: new Map(),
    isUserOnline: vi.fn(),
    lateBindFederatedCall: vi.fn(),
  },
}));

const lookupCalls: string[] = [];
const answers = new Map<string, LookupResult>();
vi.mock('../../utils/federationLookup.js', async (importActual) => {
  const actual = await importActual<typeof import('../../utils/federationLookup.js')>();
  return {
    ...actual,
    lookupRemoteUserByHomeId: vi.fn(async (_peerOrigin: string, homeUserId: string) => {
      lookupCalls.push(homeUserId);
      return answers.get(homeUserId) ?? { ok: false, reason: 'not_found' };
    }),
  };
});

/**
 * Profile image downloads wait for `assetGate` (when set). They answer 404,
 * so the row stores the absolute URL and no file is written, unless
 * `serveImages` is set: then they answer with an image, which is written to
 * UPLOAD_DIR.
 */
let assetGate: Promise<void> | null = null;
let serveImages = false;
const assetFetches: string[] = [];
vi.mock('../../utils/ssrf.js', async (importActual) => {
  const actual = await importActual<typeof import('../../utils/ssrf.js')>();
  return {
    ...actual,
    safeFetch: vi.fn(async (url: string) => {
      assetFetches.push(url);
      if (assetGate) await assetGate;
      if (serveImages) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/webp' } });
      return new Response('not found', { status: 404 });
    }),
  };
});

function uploadedFiles(): string[] {
  return fs.readdirSync(UPLOAD_DIR);
}

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const HOME = 'orbit.ddns.net';
const HOME_ORIGIN = `https://${HOME}`;

function answer(homeUserId: string, username: string, profile: Record<string, unknown>): LookupResult {
  return {
    ok: true,
    homeUserId,
    username,
    profile: { displayName: null, avatar: null, avatarColor: null, banner: null, bio: null, ...profile },
  } as LookupResult;
}

function row(id: string): typeof schema.users.$inferSelect {
  return testDb.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
}

function insertReplica(values: Partial<typeof schema.users.$inferInsert> & { id: string; username: string; homeUserId: string }): void {
  testDb.insert(schema.users).values({
    passwordHash: '!federation-replicated',
    status: 'offline',
    isAdmin: 0,
    homeInstance: HOME,
    createdAt: 1,
    ...values,
  }).run();
}

afterAll(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  lookupCalls.length = 0;
  answers.clear();
  sendToUser.mockReset();
  assetGate = null;
  serveImages = false;
  assetFetches.length = 0;
  for (const file of uploadedFiles()) fs.rmSync(path.join(UPLOAD_DIR, file), { force: true });
  testDb.insert(schema.federationPeers).values({
    id: 'peer-orbit', origin: HOME_ORIGIN, hmacSecret: 'a'.repeat(64), status: 'active', createdAt: 1,
  }).run();
  const { _resetHomeRecordPulls } = await import('../../utils/federationStubBackfill.js');
  _resetHomeRecordPulls();
});

describe('a new row for a remote user takes its profile from the home', () => {
  it('replaces the stale snapshot the row was created from', async () => {
    answers.set('1001', answer('1001', 'kai', { displayName: 'Kai', avatarColor: 'mint', accentColor: '#7c6cf6', profileUpdatedAt: 5000 }));
    const { resolveOrCreateReplicatedUser, hydrateReplicatedUserProfile } = await import('../federation.js');

    const created = resolveOrCreateReplicatedUser('1001', HOME, testDb, { username: 'kai' })!;
    await hydrateReplicatedUserProfile(created, { username: 'kai', displayName: 'Old Kai', avatarColor: 'rose' }, testDb);

    await vi.waitFor(() => expect(row(created.id).profileUpdatedAt).toBe(5000));
    const stored = row(created.id);
    expect(stored.avatarColor).toBe('mint');
    expect(stored.displayName).toBe('Kai');
    expect(stored.accentColor).toBe('#7c6cf6');
    expect(lookupCalls).toEqual(['1001']);
  });

  it('a home answer that lands while hydration downloads an image wins, and the download is removed', async () => {
    answers.set('1004', answer('1004', 'kai', { displayName: 'Kai', avatarColor: 'mint', profileUpdatedAt: 5000 }));
    let release: () => void = () => undefined;
    assetGate = new Promise<void>(resolve => { release = resolve; });
    serveImages = true;
    const { resolveOrCreateReplicatedUser, hydrateReplicatedUserProfile } = await import('../federation.js');

    const created = resolveOrCreateReplicatedUser('1004', HOME, testDb, { username: 'kai' })!;
    const hydrating = hydrateReplicatedUserProfile(created, {
      username: 'kai', displayName: 'Old Kai', avatarColor: 'rose', avatar: 'old.webp', bio: 'old bio',
    }, testDb);
    // The pull lands while hydration waits on the avatar download.
    await vi.waitFor(() => expect(row(created.id).profileUpdatedAt).toBe(5000));
    expect(assetFetches).toEqual([`${HOME_ORIGIN}/api/uploads/old.webp`]);
    sendToUser.mockClear();
    release();
    const returned = await hydrating;

    const stored = row(created.id);
    expect(stored.displayName).toBe('Kai');
    expect(stored.avatarColor).toBe('mint');
    // The home left these empty: the snapshot does not bring them back.
    expect(stored.avatar).toBeNull();
    expect(stored.bio).toBeNull();
    expect(uploadedFiles()).toEqual([]);
    expect(returned).toEqual(stored);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('hydration leaves a column empty that the home version left empty, and downloads nothing', async () => {
    insertReplica({
      id: 'r-1006', username: `kai@${HOME}`, homeUserId: '1006', displayName: 'Kai', profileUpdatedAt: 5000,
    });
    serveImages = true;
    const { hydrateReplicatedUserProfile } = await import('../federation.js');

    await hydrateReplicatedUserProfile(row('r-1006'), {
      username: 'kai', displayName: 'Old Kai', avatar: 'old.webp', banner: 'old-banner.webp', avatarColor: 'rose', bio: 'old bio',
    }, testDb);

    const stored = row('r-1006');
    expect(stored.displayName).toBe('Kai');
    expect(stored.avatar).toBeNull();
    expect(stored.banner).toBeNull();
    expect(stored.avatarColor).toBeNull();
    expect(stored.bio).toBeNull();
    expect(assetFetches).toEqual([]);
    expect(uploadedFiles()).toEqual([]);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('hydration still fills empty columns of a row the home never answered with a version', async () => {
    insertReplica({ id: 'r-1007', username: `kai@${HOME}`, homeUserId: '1007', avatarColor: 'mint' });
    testDb.insert(schema.users).values({ id: 'alice', username: 'alice', passwordHash: 'x', createdAt: 1 }).run();
    testDb.insert(schema.dmChannels).values({ id: 'ch', federatedId: 'fed', createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values([{ dmChannelId: 'ch', userId: 'alice' }, { dmChannelId: 'ch', userId: 'r-1007' }]).run();
    serveImages = true;
    const { hydrateReplicatedUserProfile } = await import('../federation.js');

    const returned = await hydrateReplicatedUserProfile(row('r-1007'), {
      username: 'kai', displayName: 'Kai', avatar: 'kai.webp', avatarColor: 'rose', bio: 'hi',
    }, testDb);

    const stored = row('r-1007');
    expect(stored.displayName).toBe('Kai');
    expect(stored.avatarColor).toBe('mint');
    expect(stored.bio).toBe('hi');
    expect(uploadedFiles()).toEqual([stored.avatar]);
    expect(returned).toEqual(stored);
    expect(sendToUser).toHaveBeenCalledWith('alice', expect.objectContaining({ type: 'user_updated' }));
  });

  it('hydration from a row read before the home answered keeps what the home wrote', async () => {
    insertReplica({ id: 'r-1005', username: `kai@${HOME}`, homeUserId: '1005' });
    const before = row('r-1005');
    testDb.update(schema.users)
      .set({ displayName: 'Kai', avatarColor: 'mint', profileUpdatedAt: 5000 })
      .where(eq(schema.users.id, 'r-1005'))
      .run();
    const { hydrateReplicatedUserProfile } = await import('../federation.js');

    await hydrateReplicatedUserProfile(before, { username: 'kai', displayName: 'Old Kai', avatarColor: 'rose', bio: 'old bio' }, testDb);

    expect(row('r-1005').displayName).toBe('Kai');
    expect(row('r-1005').avatarColor).toBe('mint');
    expect(row('r-1005').bio).toBeNull();
  });

  it('asks nothing when the home is not an active peer', async () => {
    testDb.update(schema.federationPeers).set({ status: 'unreachable' }).run();
    answers.set('1002', answer('1002', 'kai', { avatarColor: 'mint', profileUpdatedAt: 5000 }));
    const { resolveOrCreateReplicatedUser } = await import('../federation.js');

    resolveOrCreateReplicatedUser('1002', HOME, testDb, { username: 'kai' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(lookupCalls).toEqual([]);
  });

  it('asks once for a row whose pull is already under way', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { lookupRemoteUserByHomeId } = await import('../../utils/federationLookup.js');
    vi.mocked(lookupRemoteUserByHomeId).mockImplementationOnce(async (_o: string, homeUserId: string) => {
      lookupCalls.push(homeUserId);
      await gate;
      return answer('1003', 'kai', { profileUpdatedAt: 5000 });
    });
    insertReplica({ id: 'r-1003', username: `kai@${HOME}`, homeUserId: '1003' });
    const { scheduleHomeRecordPull } = await import('../../utils/federationStubBackfill.js');

    scheduleHomeRecordPull(row('r-1003'));
    scheduleHomeRecordPull(row('r-1003'));
    release();
    await vi.waitFor(() => expect(row('r-1003').profileUpdatedAt).toBe(5000));
    expect(lookupCalls).toEqual(['1003']);
  });
});

describe('applyHomeProfile version rules', () => {
  it('an answer without a version (an older home) applies only while the row has none', async () => {
    insertReplica({ id: 'r-a', username: `ann@${HOME}`, homeUserId: '2001', avatarColor: 'rose' });
    insertReplica({ id: 'r-b', username: `ben@${HOME}`, homeUserId: '2002', avatarColor: 'rose', profileUpdatedAt: 1000 });
    const { applyHomeProfile } = await import('./profile.js');
    const unversioned = { profileUpdatedAt: null, username: 'x', displayName: null, avatar: null, banner: null, avatarColor: 'mint', bio: null };

    await applyHomeProfile(row('r-a'), { ...unversioned, username: 'ann' }, HOME_ORIGIN, testDb);
    await applyHomeProfile(row('r-b'), { ...unversioned, username: 'ben' }, HOME_ORIGIN, testDb);

    expect(row('r-a').avatarColor).toBe('mint');
    expect(row('r-a').profileUpdatedAt).toBeNull();
    expect(row('r-b').avatarColor).toBe('rose');
  });

  it('an older version never replaces a newer one', async () => {
    insertReplica({ id: 'r-c', username: `cat@${HOME}`, homeUserId: '2003', avatarColor: 'mint', profileUpdatedAt: 9000 });
    const { applyHomeProfile } = await import('./profile.js');

    await applyHomeProfile(row('r-c'), {
      profileUpdatedAt: 4000, username: 'cat', displayName: null, avatar: null, banner: null, avatarColor: 'rose', bio: null,
    }, HOME_ORIGIN, testDb);

    expect(row('r-c').avatarColor).toBe('mint');
    expect(row('r-c').profileUpdatedAt).toBe(9000);
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('an answer without an accent colour keeps the stored one', async () => {
    insertReplica({ id: 'r-d', username: `dan@${HOME}`, homeUserId: '2004', accentColor: '#112233' });
    const { applyHomeProfile } = await import('./profile.js');

    await applyHomeProfile(row('r-d'), {
      profileUpdatedAt: 4000, username: 'dan', displayName: null, avatar: null, banner: null, avatarColor: 'rose', bio: null,
    }, HOME_ORIGIN, testDb);

    expect(row('r-d').accentColor).toBe('#112233');
    expect(row('r-d').avatarColor).toBe('rose');
  });

  it('the display name falls back to the handle, never to a row name', async () => {
    insertReplica({ id: 'r-e', username: `eve@${HOME}`, homeUserId: '2005' });
    const { applyHomeProfile } = await import('./profile.js');

    await applyHomeProfile(row('r-e'), {
      profileUpdatedAt: 4000, username: `eve~1@${HOME}`, displayName: null, avatar: null, banner: null, avatarColor: null, bio: null,
    }, HOME_ORIGIN, testDb);

    expect(row('r-e').displayName).toBeNull();
  });
});

describe('relayed snapshots carry the handle', () => {
  it('hydration never takes a row name as the display name', async () => {
    insertReplica({ id: 'r-f', username: `fay@${HOME}`, homeUserId: '3001' });
    insertReplica({ id: 'r-g', username: `gus@${HOME}`, homeUserId: '3002' });
    const { hydrateReplicatedUserProfile } = await import('../federation.js');

    await hydrateReplicatedUserProfile(row('r-f'), { username: `fay~1@${HOME}`, displayName: null }, testDb);
    await hydrateReplicatedUserProfile(row('r-g'), { username: 'gus', displayName: null }, testDb);

    expect(row('r-f').displayName).toBeNull();
    expect(row('r-g').displayName).toBe('gus');
  });

  it('snapshot builders send the handle of a suffixed replica, nothing for a placeholder name', async () => {
    testDb.insert(schema.users).values({ id: 'alice', username: 'alice', passwordHash: 'x', createdAt: 1 }).run();
    insertReplica({ id: 'r-kai', username: `kai~1@${HOME}`, homeUserId: '4001' });
    insertReplica({ id: 'r-id', username: `4002@${HOME}`, homeUserId: '4002' });
    insertReplica({ id: 'r-acc', username: `max@${HOME}`, homeUserId: '4003', passwordHash: 'real-hash' });
    testDb.insert(schema.dmChannels).values({ id: 'ch', federatedId: 'fed', createdAt: 1 }).run();
    testDb.insert(schema.dmMembers).values(['alice', 'r-kai', 'r-id', 'r-acc'].map(userId => ({ dmChannelId: 'ch', userId }))).run();
    const { getDmParticipants } = await import('../../utils/federationOutbox.js');
    const { buildProfileSnapshot } = await import('../social.js');

    const byId = new Map(getDmParticipants('ch').map(p => [p.homeUserId, p.profile?.username]));
    expect(byId.get('alice')).toBe('alice');
    expect(byId.get('4001')).toBe('kai');
    expect(byId.get('4002')).toBeNull();
    expect(byId.get('4003')).toBe('max');
    expect(buildProfileSnapshot(row('r-kai')).username).toBe('kai');
    expect(buildProfileSnapshot(row('alice')).username).toBe('alice');
  });
});
