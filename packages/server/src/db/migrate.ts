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
 * Heal column drift between an existing install and the 0000_initial
 * schema baseline.
 *
 * The baseline in `baselineExistingInstall` assumes that any existing
 * install's schema already matches 0000_initial.sql. That assumption is
 * usually fine for installs created through the old pre-drizzle manual
 * migration system — but a DB can fall behind if it skipped one of those
 * manual ALTERs (e.g. a dev-env that was paused before the
 * `remote_max_upload_size` migration in 1e4e71a landed). On such DBs,
 * baseline marks 0000 as applied without the columns actually being
 * there, and a later migration that recreates the table (e.g.
 * 0004_cooing_black_knight) crashes trying to SELECT them.
 *
 * Walks every table defined in 0000_snapshot.json; for each that already
 * exists in the DB, ADDs any columns the snapshot declares but the table
 * is missing. Idempotent: on a correctly-migrated DB every column is
 * already present and the loop is a no-op. Columns that SQLite's
 * ALTER TABLE ADD COLUMN cannot express (PRIMARY KEY; NOT NULL without a
 * default) are skipped with a warning rather than corrupting data.
 *
 * Only reconciles against the 0000 baseline — later migrations add their
 * own columns through normal migration SQL and are handled by
 * Drizzle's migrator.
 */
export function healInitialSchemaDrift(db: Database.Database): void {
  const migrationsFolder = path.resolve(__dirname, '../../drizzle');
  const snapshotPath = path.join(migrationsFolder, 'meta', '0000_snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as {
    tables: Record<string, {
      name: string;
      columns: Record<string, {
        name: string;
        type: string;
        primaryKey: boolean;
        notNull: boolean;
        autoincrement: boolean;
        default?: string | number;
      }>;
    }>;
  };

  for (const table of Object.values(snapshot.tables)) {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table.name);
    if (!exists) continue;

    const existingCols = new Set(
      (db.prepare(`PRAGMA table_info("${table.name}")`).all() as { name: string }[])
        .map(c => c.name)
    );

    for (const col of Object.values(table.columns)) {
      if (existingCols.has(col.name)) continue;

      if (col.primaryKey) {
        console.warn(`[migrate] Skipping drift heal for ${table.name}.${col.name}: PRIMARY KEY cannot be added via ALTER TABLE`);
        continue;
      }
      if (col.notNull && col.default === undefined) {
        console.warn(`[migrate] Skipping drift heal for ${table.name}.${col.name}: NOT NULL with no default (would violate existing rows)`);
        continue;
      }

      const parts = [`"${col.name}"`, col.type];
      if (col.notNull) parts.push('NOT NULL');
      if (col.default !== undefined) parts.push(`DEFAULT ${col.default}`);

      const sql = `ALTER TABLE "${table.name}" ADD COLUMN ${parts.join(' ')}`;
      console.log(`[migrate] Healing schema drift: ${sql}`);
      db.exec(sql);
    }
  }
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
