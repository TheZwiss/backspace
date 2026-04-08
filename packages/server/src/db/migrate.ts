import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Baseline an existing install so Drizzle's migrate() skips the initial
 * migration (tables already exist). Must be called BEFORE migrate().
 *
 * Detects existing installs by checking: users table exists but
 * __drizzle_migrations table does not.
 *
 * Drizzle's __drizzle_migrations table schema (verified SQLite DDL):
 *   "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL
 *   "hash" text NOT NULL      -- SHA-256 hex of the migration SQL file (raw UTF-8)
 *   "created_at" numeric      -- journalEntry.when (ms timestamp from journal)
 *
 * Hash must match Drizzle's exactly: read SQL file as raw UTF-8 string,
 * hash it with SHA-256. Line endings matter — don't normalize \r\n vs \n.
 */
export function baselineExistingInstall(db: Database.Database): void {
  const hasUsers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  ).get();
  const hasJournal = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'"
  ).get();

  if (!hasUsers || hasJournal) return; // Fresh install or already baselined

  console.log('[migrate] Existing install detected — baselining Drizzle migrations...');

  // Read the journal to get the initial migration metadata
  const migrationsFolder = path.resolve(__dirname, '../../drizzle');
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
  const initialEntry = journal.entries[0];

  if (!initialEntry) {
    throw new Error('No entries found in drizzle migration journal');
  }

  // Compute the hash the same way Drizzle does: SHA-256 of the SQL file content
  const sqlPath = path.join(migrationsFolder, `${initialEntry.tag}.sql`);
  const sqlContent = fs.readFileSync(sqlPath, 'utf-8');
  const hash = crypto.createHash('sha256').update(sqlContent).digest('hex');

  // Create the journal table matching Drizzle's exact SQLite DDL
  db.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "hash" text NOT NULL,
      "created_at" numeric
    )
  `);

  db.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)'
  ).run(hash, initialEntry.when);

  console.log(`[migrate] Baselined initial migration: ${initialEntry.tag} (hash: ${hash.slice(0, 12)}...)`);
}

/**
 * Ensure data invariants after schema migration. Idempotent — safe to run
 * on every boot. Uses raw better-sqlite3 handle (not Drizzle ORM).
 */
export function ensureDefaults(db: Database.Database): void {
  // 1. Ensure the single-row instance_settings row exists
  const row = db.prepare('SELECT id FROM instance_settings WHERE id = 1').get();
  if (!row) {
    db.prepare(
      `INSERT OR IGNORE INTO instance_settings
        (id, max_bitrate_kbps, min_bitrate_kbps, bitrate_step_kbps,
         allowed_resolutions, allowed_framerates, max_resolution, max_framerate, updated_at)
       VALUES (1, 20000, 500, 500, ?, ?, 1080, 60, ?)`
    ).run('540,720,1080', '30,45,60', Date.now());
    console.log('[defaults] Inserted default instance_settings row');
  }

  // 2. Ensure a unique Snowflake worker ID is persisted (0-1023)
  const settings = db.prepare('SELECT worker_id FROM instance_settings WHERE id = 1').get() as
    { worker_id: number | null } | undefined;
  if (!settings || settings.worker_id === null) {
    const workerId = crypto.randomInt(0, 1024);
    db.prepare('UPDATE instance_settings SET worker_id = ? WHERE id = 1').run(workerId);
    console.log(`[defaults] Generated Snowflake worker ID: ${workerId}`);
  }

  // 3. Ensure at least one admin exists (promote earliest registered user)
  const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (!anyAdmin) {
    const firstUser = db.prepare(
      'SELECT id FROM users ORDER BY created_at ASC LIMIT 1'
    ).get() as { id: string } | undefined;
    if (firstUser) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(firstUser.id);
      console.log(`[defaults] Promoted first user ${firstUser.id} to admin`);
    }
  }
}
