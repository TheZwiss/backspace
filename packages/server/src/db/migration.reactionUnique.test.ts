import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Migration 0024 (#393): one reaction per user, emoji and message. Installs
 * created from the squashed 0000 had no unique key on the reaction tables,
 * so the same user's reaction could be stored several times. The migration
 * deletes the repeats, keeping the earliest row of each key (of two equally
 * early ones, the lower rowid), then creates the unique indexes. The
 * upgrade from every database shape in the field is in preSquashUpgrade.test.ts.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');
const TAG = '0024_reaction_unique';

function statementsOf(file: string): string[] {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    .split(/-->\s*statement-breakpoint/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function applyUpTo(db: Database.Database, tag: string): void {
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
    if (file.startsWith(tag)) return;
    for (const stmt of statementsOf(file)) db.exec(stmt);
  }
  throw new Error(`migration ${tag} not found`);
}

function applyMigration(db: Database.Database): void {
  for (const stmt of statementsOf(`${TAG}.sql`)) db.exec(stmt);
}

const TABLES = [
  { table: 'reactions', messageColumn: 'message_id', messageId: 'msg-1' },
  { table: 'dm_reactions', messageColumn: 'dm_message_id', messageId: 'dm-msg-1' },
] as const;

function seedParents(db: Database.Database): void {
  const user = db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, \'x\', 1)');
  for (const id of ['alice', 'bob']) user.run(id, id);
  db.prepare("INSERT INTO spaces (id, name, owner_id, created_at) VALUES ('space-1', 'space', 'alice', 1)").run();
  db.prepare("INSERT INTO channels (id, space_id, name, type, created_at) VALUES ('chan-1', 'space-1', 'general', 'text', 1)").run();
  db.prepare("INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES ('msg-1', 'chan-1', 'alice', 'hi', 1)").run();
  db.prepare("INSERT INTO dm_channels (id, created_at) VALUES ('dm-1', 1)").run();
  db.prepare("INSERT INTO dm_messages (id, dm_channel_id, user_id, content, created_at) VALUES ('dm-msg-1', 'dm-1', 'alice', 'hi', 1)").run();
}

function insertReaction(db: Database.Database, table: typeof TABLES[number], id: string, userId: string, emoji: string, createdAt: number): void {
  db.prepare(`INSERT INTO ${table.table} (id, ${table.messageColumn}, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, table.messageId, userId, emoji, createdAt);
}

function idsIn(db: Database.Database, table: typeof TABLES[number]): string[] {
  return (db.prepare(`SELECT id FROM ${table.table} ORDER BY id`).all() as Array<{ id: string }>).map(r => r.id);
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyUpTo(db, TAG);
  seedParents(db);
});

describe('migration 0024_reaction_unique', () => {
  it.each(TABLES)('keeps the earliest of a user\'s repeated reaction in $table', (table) => {
    insertReaction(db, table, 'b-late', 'bob', '👍', 300);
    insertReaction(db, table, 'c-early', 'bob', '👍', 100);
    insertReaction(db, table, 'a-middle', 'bob', '👍', 200);
    applyMigration(db);
    expect(idsIn(db, table)).toEqual(['c-early']);
  });

  it.each(TABLES)('keeps the lower rowid of two equally early repeats in $table', (table) => {
    // Without a VACUUM the row inserted first has the lower rowid.
    insertReaction(db, table, 'z-first', 'bob', '👍', 100);
    insertReaction(db, table, 'a-second', 'bob', '👍', 100);
    applyMigration(db);
    expect(idsIn(db, table)).toEqual(['z-first']);
  });

  it.each(TABLES)('leaves other users\' reactions and the user\'s other emoji in $table', (table) => {
    insertReaction(db, table, 'r1', 'bob', '👍', 100);
    insertReaction(db, table, 'r2', 'bob', '👍', 200);
    insertReaction(db, table, 'r3', 'alice', '👍', 300);
    insertReaction(db, table, 'r4', 'bob', '🎉', 400);
    applyMigration(db);
    expect(idsIn(db, table)).toEqual(['r1', 'r3', 'r4']);
  });

  it.each(TABLES)('refuses a repeat in $table afterwards', (table) => {
    insertReaction(db, table, 'r1', 'bob', '👍', 100);
    applyMigration(db);
    expect(() => insertReaction(db, table, 'r2', 'bob', '👍', 200)).toThrow(/UNIQUE constraint failed/);
    insertReaction(db, table, 'r3', 'alice', '👍', 300);
    expect(idsIn(db, table)).toEqual(['r1', 'r3']);
  });

  it('runs on tables with no reactions', () => {
    applyMigration(db);
    for (const table of TABLES) expect(idsIn(db, table)).toEqual([]);
  });

  it('creates the index beside an inline UNIQUE on the same columns', () => {
    // The shape a pre-squash install has: the old hand-written statements
    // declared the key inline.
    const old = new Database(':memory:');
    old.exec(`
      CREATE TABLE reactions (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(message_id, user_id, emoji));
      CREATE TABLE dm_reactions (id TEXT PRIMARY KEY, dm_message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(dm_message_id, user_id, emoji));
      INSERT INTO reactions VALUES ('r1', 'msg-1', 'bob', '👍', 1);
      INSERT INTO dm_reactions VALUES ('d1', 'dm-msg-1', 'bob', '👍', 1);
    `);
    applyMigration(old);
    for (const table of TABLES) {
      expect(idsIn(old, table)).toEqual([table.table === 'reactions' ? 'r1' : 'd1']);
      const origins = (old.prepare(`PRAGMA index_list(${table.table})`).all() as Array<{ origin: string }>).map(i => i.origin).sort();
      expect(origins).toEqual(['c', 'pk', 'u']);
    }
    old.close();
  });
});
