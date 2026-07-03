import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(id: string, extra: Partial<typeof schema.users.$inferInsert> = {}) {
  testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: Date.now(), ...extra }).run();
}
function seedDm(id: string, ownerId: string | null) {
  testDb.insert(schema.dmChannels).values({ id, ownerId, createdAt: Date.now() }).run();
}
function seedMember(dmChannelId: string, userId: string) {
  testDb.insert(schema.dmMembers).values({ dmChannelId, userId, closed: 0 }).run();
}
function seedDmMessage(id: string, dmChannelId: string, userId: string) {
  testDb.insert(schema.dmMessages).values({ id, dmChannelId, userId, content: 'x', createdAt: Date.now() }).run();
}

describe('tombstoneUser — DM membership partition', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    // Match production (db/index.ts:31): FK enforcement ON. better-sqlite3 defaults
    // this OFF, which would silently skip the dm_channels→dm_members/dm_messages
    // cascade and let orphaned rows survive a purge unnoticed.
    sqlite.pragma('foreign_keys = ON');
    vi.clearAllMocks();
  });
  afterEach(() => sqlite.close());

  it('keeps the deleted user 1-on-1 membership, removes group membership', async () => {
    const { tombstoneUser } = await import('./userDeletion.js');
    seedUser('victim'); seedUser('survivor'); seedUser('groupmate');
    seedDm('dm_1on1', null);   seedMember('dm_1on1', 'victim'); seedMember('dm_1on1', 'survivor');
    seedDm('dm_group', 'survivor'); seedMember('dm_group', 'victim'); seedMember('dm_group', 'survivor'); seedMember('dm_group', 'groupmate');

    tombstoneUser('victim', { purgeContent: false });

    const memberships = testDb.select().from(schema.dmMembers).where(eq(schema.dmMembers.userId, 'victim')).all();
    expect(memberships.map(m => m.dmChannelId)).toEqual(['dm_1on1']); // 1-on-1 kept, group removed
    // Survivor's 1-on-1 channel still exists and still has the survivor
    expect(testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm_1on1')).get()).toBeTruthy();
  });

  it('keeps a Deleted<->Survivor 1-on-1, purges a Deleted<->Deleted 1-on-1', async () => {
    const { tombstoneUser } = await import('./userDeletion.js');
    seedUser('alreadyDead', { isDeleted: 1 });
    seedUser('victim'); seedUser('survivor');
    // Survivor thread — must survive
    seedDm('dm_live', null); seedMember('dm_live', 'victim'); seedMember('dm_live', 'survivor');
    // Both-dead thread — victim + an already-deleted partner → must be purged
    seedDm('dm_dead', null); seedMember('dm_dead', 'victim'); seedMember('dm_dead', 'alreadyDead');
    seedDmMessage('msg_dead', 'dm_dead', 'victim');

    tombstoneUser('victim', { purgeContent: false });

    expect(testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm_live')).get()).toBeTruthy();
    expect(testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm_dead')).get()).toBeUndefined();
    // Cascade cleanup: with FK ON, dropping the dm_channels row must also remove its
    // dm_members and dm_messages — no orphaned rows may linger.
    expect(testDb.select().from(schema.dmMembers).where(eq(schema.dmMembers.dmChannelId, 'dm_dead')).all()).toEqual([]);
    expect(testDb.select().from(schema.dmMessages).where(eq(schema.dmMessages.dmChannelId, 'dm_dead')).all()).toEqual([]);
  });

  it('transfers owned group DM to a LIVE member, never a tombstoned one', async () => {
    const { tombstoneUser } = await import('./userDeletion.js');
    seedUser('owner'); seedUser('deadmate', { isDeleted: 1 }); seedUser('livemate');
    // owner owns a group DM whose other members are one dead + one live.
    // The membership rows are ordered so the dead member would be picked first
    // by an unfiltered `LIMIT 1` — proving the isDeleted=0 guard is what selects livemate.
    seedDm('dm_owned', 'owner');
    seedMember('dm_owned', 'owner');
    seedMember('dm_owned', 'deadmate');
    seedMember('dm_owned', 'livemate');

    tombstoneUser('owner', { purgeContent: false });

    const channel = testDb.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, 'dm_owned')).get();
    expect(channel?.ownerId).toBe('livemate');
  });
});
