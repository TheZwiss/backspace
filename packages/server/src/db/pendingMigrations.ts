import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

interface DrizzleJournal { entries: Array<{ idx: number; tag: string; when: number }>; }

/**
 * True when migrations are pending. Drizzle's better-sqlite3 migrator appends one
 * row per applied migration to `__drizzle_migrations`, in journal order. Comparing
 * the applied row count to the journal entry count is sufficient to know whether
 * `migrate()` will apply anything — without running it. A missing table means a
 * pre-drizzle or empty DB: treat as pending.
 */
export function hasPendingMigrations(db: Database.Database, migrationsFolder: string): boolean {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as DrizzleJournal;

  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (!tableExists) return true;

  const applied = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
  return applied.n < journal.entries.length;
}
