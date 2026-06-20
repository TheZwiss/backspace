import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaults } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

describe('fresh instance has no seeded credentials', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    ensureDefaults(sqlite);
  });

  it('creates no admin user and no default space on fresh boot', () => {
    const users = sqlite.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    const spaces = sqlite.prepare('SELECT COUNT(*) AS n FROM spaces').get() as { n: number };
    expect(users.n).toBe(0);
    expect(spaces.n).toBe(0);
  });

  it('has no user named "admin"', () => {
    const admin = sqlite.prepare("SELECT id FROM users WHERE username = 'admin'").get();
    expect(admin).toBeUndefined();
  });

  it('still creates the singleton instance_settings row', () => {
    const row = sqlite.prepare('SELECT id, worker_id FROM instance_settings WHERE id = 1').get() as
      { id: number; worker_id: number | null } | undefined;
    expect(row?.id).toBe(1);
    expect(row?.worker_id).not.toBeNull();
  });
});
