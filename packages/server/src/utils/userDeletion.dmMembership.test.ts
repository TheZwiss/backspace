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

describe('tombstoneUser — DM membership partition', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
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
});
