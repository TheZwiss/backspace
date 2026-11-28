import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(id: string): void {
  testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: Date.now() }).run();
}

function seedBookmark(id: string, userId: string, copyFilename: string | null): void {
  testDb.insert(schema.messageBookmarks).values({
    id, userId, kind: 'dm', messageId: `msg-${id}`, channelId: 'dm-1', content: 'saved', authorId: 'someone',
    authorName: 'Someone', instanceOrigin: 'https://local.test', messageCreatedAt: 1, createdAt: 1,
  }).run();
  testDb.insert(schema.bookmarkAttachments).values({
    id: `att-${id}`, bookmarkId: id, position: 0, originalName: 'a.png', mimetype: 'image/png', size: 4,
    sourceFilename: `source-${id}.png`, filename: copyFilename, copyStatus: copyFilename ? 'copied' : 'reference',
  }).run();
}

describe('tombstoneUser — bookmarks', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    // As in production: foreign keys are enforced.
    sqlite.pragma('foreign_keys = ON');
  });
  afterEach(() => sqlite.close());

  it('removes the deleted user\'s bookmarks, which the users cascade would miss, and returns the files they owned', async () => {
    const { tombstoneUser } = await import('./userDeletion.js');
    seedUser('victim');
    seedUser('other');
    seedBookmark('b-victim-ref', 'victim', null);
    seedBookmark('b-victim-copy', 'victim', 'copy-1.png');
    seedBookmark('b-other', 'other', 'copy-2.png');

    const files = tombstoneUser('victim');

    // The users row stays (a tombstone), so only the explicit purge can have removed these.
    expect(testDb.select().from(schema.users).all().map((u) => u.id).sort()).toEqual(['other', 'victim']);
    expect(files).toContain('copy-1.png');
    expect(files).not.toContain('copy-2.png');
    expect(files).not.toContain('source-b-victim-ref.png');
    expect(files).not.toContain('source-b-victim-copy.png');
    expect(testDb.select().from(schema.messageBookmarks).all().map((b) => b.id)).toEqual(['b-other']);
    expect(testDb.select().from(schema.bookmarkAttachments).all().map((a) => a.bookmarkId)).toEqual(['b-other']);
  });
});
