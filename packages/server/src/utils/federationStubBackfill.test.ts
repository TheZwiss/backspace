import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { setWorkerId } from './snowflake.js';

// resolveOrCreateReplicatedUser (tested below) mints a snowflake for the new
// stub row; the register route mints one for fresh accounts. Both throw if the
// worker id is never initialised. Set it once at module load.
setWorkerId(3);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const lookupCalls: Array<{ peerOrigin: string; homeUserId: string }> = [];
const lookupResponses = new Map<string, unknown>();

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('./federationLookup.js', () => ({
  lookupRemoteUserByHomeId: vi.fn(async (peerOrigin: string, homeUserId: string) => {
    lookupCalls.push({ peerOrigin, homeUserId });
    const r = lookupResponses.get(homeUserId);
    if (!r) return { ok: false, reason: 'not_found' };
    return r;
  }),
}));

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

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  lookupCalls.length = 0;
  lookupResponses.clear();
  // Active peer
  testDb.insert(schema.federationPeers).values({
    id: 'peer-orbit',
    origin: 'https://orbit.ddns.net',
    hmacSecret: 'a'.repeat(64),
    status: 'active',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }).run();
});

describe('backfillStubUsernamesForPeer', () => {
  it('rewrites snowflake-style username to realname when lookup succeeds', async () => {
    // Seed legacy stub: username = `${homeUserId}@${domain}` (the old scheme)
    testDb.insert(schema.users).values({
      id: 'stub-1',
      username: 'home-1@orbit.ddns.net',
      displayName: null,
      passwordHash: '!federation-replicated',
      status: 'offline',
      isAdmin: 0,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'home-1',
      createdAt: Date.now(),
    }).run();
    lookupResponses.set('home-1', {
      ok: true,
      homeUserId: 'home-1',
      username: 'pbtest3',
      profile: { displayName: null, avatar: null, avatarColor: null, banner: null, bio: null },
    });

    const { backfillStubUsernamesForPeer } = await import('./federationStubBackfill.js');
    await backfillStubUsernamesForPeer('https://orbit.ddns.net');

    expect(lookupCalls).toEqual([{ peerOrigin: 'https://orbit.ddns.net', homeUserId: 'home-1' }]);
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-1')).get();
    expect(row!.username).toBe('pbtest3@orbit.ddns.net');
    expect(row!.displayName).toBe('pbtest3'); // displayName ?? username fallback fills in real handle
  });

  it('skips stubs whose username is already human-readable (no lookup triggered)', async () => {
    testDb.insert(schema.users).values({
      id: 'stub-1',
      username: 'pbtest3@orbit.ddns.net',  // already migrated
      displayName: 'pbtest3',
      passwordHash: '!federation-replicated',
      status: 'offline',
      isAdmin: 0,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'home-1',
      createdAt: Date.now(),
    }).run();

    const { backfillStubUsernamesForPeer } = await import('./federationStubBackfill.js');
    await backfillStubUsernamesForPeer('https://orbit.ddns.net');

    expect(lookupCalls).toEqual([]); // no lookup triggered
  });

  it('leaves stub untouched on lookup miss (tombstoned home user)', async () => {
    testDb.insert(schema.users).values({
      id: 'stub-1',
      username: 'unknown-id@orbit.ddns.net',
      displayName: null,
      passwordHash: '!federation-replicated',
      status: 'offline',
      isAdmin: 0,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'unknown-id',
      createdAt: Date.now(),
    }).run();
    // No lookupResponses entry → mock returns { ok: false, reason: 'not_found' }

    const { backfillStubUsernamesForPeer } = await import('./federationStubBackfill.js');
    await backfillStubUsernamesForPeer('https://orbit.ddns.net');

    const row = testDb.select().from(schema.users).where(eq(schema.users.id, 'stub-1')).get();
    expect(row!.username).toBe('unknown-id@orbit.ddns.net'); // unchanged
    expect(row!.displayName).toBeNull(); // unchanged
  });

  it('is a no-op when peer is not active', async () => {
    testDb.update(schema.federationPeers)
      .set({ status: 'unreachable' })
      .where(eq(schema.federationPeers.id, 'peer-orbit'))
      .run();
    testDb.insert(schema.users).values({
      id: 'stub-1',
      username: 'home-1@orbit.ddns.net',
      displayName: null,
      passwordHash: '!federation-replicated',
      status: 'offline',
      isAdmin: 0,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'home-1',
      createdAt: Date.now(),
    }).run();
    lookupResponses.set('home-1', {
      ok: true,
      homeUserId: 'home-1',
      username: 'pbtest3',
      profile: { displayName: null, avatar: null, avatarColor: null, banner: null, bio: null },
    });

    const { backfillStubUsernamesForPeer } = await import('./federationStubBackfill.js');
    await backfillStubUsernamesForPeer('https://orbit.ddns.net');

    expect(lookupCalls).toEqual([]); // gated on peer status
  });
});

describe('detached account: registration 409 + suffixed stub creation (detach spec §4.3.5)', () => {
  // A detached account is a REAL federated user (homeInstance set, real bcrypt-style
  // hash — NOT the '!federation-replicated' sentinel) whose home domain was reset
  // and which has therefore been detached (federationHomeOrphaned = 1). Task 3's
  // tier-2 exclusion makes it un-matchable via the domain+username heuristic, so a
  // new same-name identity on the reset domain can neither register OVER the account
  // (§4.3.5 → username-uniqueness 409) nor be BOUND to it by relay stub resolution
  // (§4.3.4 → the collision guard suffixes a fresh stub instead).
  const detachedId = 'detached-1';
  const detachedUsername = 'alice@peer.example';
  const originalHash = '$2b$10$abcdefghijklmnopqrstuv'; // real bcrypt-like hash, not a stub

  function seedDetachedAccount(): void {
    testDb.insert(schema.users).values({
      id: detachedId,
      username: detachedUsername,
      displayName: null,
      passwordHash: originalHash,
      status: 'offline',
      isAdmin: 0,
      homeInstance: 'peer.example',
      homeUserId: 'old-home-uid',
      federationHomeOrphaned: 1,
      createdAt: Date.now(),
    }).run();
  }

  function seedFederatedRegistrationOpen(): void {
    // applyMigrations creates instance_settings but does not seed the id=1 row
    // (production does so via migrate.ts:ensureDefaults). The register route reads
    // federatedRegistrationOpen from it; without the row the federated path 403s.
    testDb.insert(schema.instanceSettings).values({
      id: 1,
      registrationOpen: 1,
      federatedRegistrationOpen: 1,
      updatedAt: Date.now(),
    }).run();
  }

  async function buildAuthApp(): Promise<FastifyInstance> {
    const { authRoutes } = await import('../routes/auth.js');
    const app = Fastify({ logger: false });
    await app.register(authRoutes);
    await app.ready();
    return app;
  }

  it('federated registration of a same-name user on the reset domain returns 409, detached row untouched', async () => {
    seedDetachedAccount();
    seedFederatedRegistrationOpen();
    const app = await buildAuthApp();
    try {
      // Fresh homeUserId + the reset domain replaying 'alice' as the handle. Tier-2
      // no longer matches the detached row → the stub-upgrade branch is skipped →
      // the plain username-uniqueness check on 'alice@peer.example' fires → 409.
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'alice@peer.example',
          password: 'password123',
          homeInstance: 'peer.example',
          homeUserId: 'new-home-uid',
        },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await app.close();
    }

    const row = testDb.select().from(schema.users).where(eq(schema.users.id, detachedId)).get();
    expect(row?.homeUserId).toBe('old-home-uid');    // no backfill
    expect(row?.passwordHash).toBe(originalHash);     // no credential upgrade/re-hash
    expect(row?.username).toBe(detachedUsername);      // handle not rebound
    expect(row?.federationHomeOrphaned).toBe(1);       // still sovereign
  });

  it('relay stub resolution creates a SUFFIXED stub instead of binding to the detached row', async () => {
    seedDetachedAccount();
    const { resolveOrCreateReplicatedUser } = await import('../routes/federation.js');

    // Fresh homeUserId → tier-1 miss; detached row is tier-2-excluded → no match.
    // The collision guard finds 'alice@peer.example' already taken and suffixes.
    const stub = resolveOrCreateReplicatedUser('new-home-uid', 'peer.example', testDb, { username: 'alice' });
    expect(stub).not.toBeNull();
    expect(stub!.id).not.toBe(detachedId);
    expect(stub!.username).not.toBe(detachedUsername);
    expect(stub!.passwordHash).toBe('!federation-replicated');
    expect(stub!.homeUserId).toBe('new-home-uid');

    // The detached account is left entirely untouched.
    const row = testDb.select().from(schema.users).where(eq(schema.users.id, detachedId)).get();
    expect(row?.username).toBe(detachedUsername);
    expect(row?.homeUserId).toBe('old-home-uid');
    expect(row?.passwordHash).toBe(originalHash);
    expect(row?.federationHomeOrphaned).toBe(1);
  });
});
