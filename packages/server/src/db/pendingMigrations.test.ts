import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPendingMigrations } from './pendingMigrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../../drizzle');

describe('hasPendingMigrations', () => {
  it('returns true when __drizzle_migrations is missing', () => {
    const db = new Database(':memory:');
    expect(hasPendingMigrations(db, migrationsFolder)).toBe(true);
  });

  it('returns true when fewer rows than journal entries are applied', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at NUMERIC)');
    db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('x', 1);
    expect(hasPendingMigrations(db, migrationsFolder)).toBe(true);
  });

  it('returns false when applied count >= journal entries', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at NUMERIC)');
    const journal = require(path.join(migrationsFolder, 'meta/_journal.json'));
    const insert = db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)');
    for (let i = 0; i < journal.entries.length; i++) insert.run(`h${i}`, i);
    expect(hasPendingMigrations(db, migrationsFolder)).toBe(false);
  });
});
