import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

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
