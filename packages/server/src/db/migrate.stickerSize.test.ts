import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { healSkippedStickerSizeMigration } from './migrate.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function setup(migrationsFolder: string): Database.Database {
  fs.mkdirSync(path.join(migrationsFolder, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), JSON.stringify({
    entries: [
      { tag: '0035_federated_sticker_store', when: 100 },
      { tag: '0036_max_sticker_size', when: 200 },
    ],
  }));
  const migration = 'ALTER TABLE instance_settings ADD max_sticker_size_bytes integer;';
  fs.writeFileSync(path.join(migrationsFolder, '0036_max_sticker_size.sql'), migration);

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE instance_settings (id integer primary key, max_sticker_size_bytes integer);
    CREATE TABLE __drizzle_migrations (id integer primary key, hash text not null, created_at integer);
  `);
  return db;
}

describe('healSkippedStickerSizeMigration', () => {
  it('uses the migration tag and timestamp from the current journal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-migrate-'));
    temporaryDirectories.push(root);
    const migrationsFolder = path.join(root, 'drizzle');
    const db = setup(migrationsFolder);

    try {
      healSkippedStickerSizeMigration(db, migrationsFolder);
      const row = db.prepare('SELECT hash, created_at FROM __drizzle_migrations').get() as {
        hash: string;
        created_at: number;
      };
      const sql = fs.readFileSync(path.join(migrationsFolder, '0036_max_sticker_size.sql'), 'utf8');
      expect(row).toEqual({
        hash: createHash('sha256').update(sql).digest('hex'),
        created_at: 200,
      });
    } finally {
      db.close();
    }
  });

  it('is idempotent once the migration record exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-migrate-'));
    temporaryDirectories.push(root);
    const migrationsFolder = path.join(root, 'drizzle');
    const db = setup(migrationsFolder);

    try {
      healSkippedStickerSizeMigration(db, migrationsFolder);
      healSkippedStickerSizeMigration(db, migrationsFolder);
      expect(db.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
