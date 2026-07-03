import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import * as schema from './schema.js';
import { ensureDefaults, backfillOneOnOneDmMembership } from './migrate.js';
import { setWorkerId } from '../utils/snowflake.js';
import { createSnapshot } from '../utils/backup.js';
import { hasPendingMigrations } from './pendingMigrations.js';
import { mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let sqlite: Database.Database;

function ensureDirectory(filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
}

export function initDatabase() {
  ensureDirectory(config.dbPath);
  // Capture existence BEFORE opening — new Database() creates the file, so a
  // post-open check would always report "exists" and snapshot a 0-row DB on first boot.
  const dbExisted = existsSync(config.dbPath);

  sqlite = new Database(config.dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const migrationsFolder = resolve(__dirname, '../../drizzle');

  // Snapshot before migrating — but only when there is a real DB AND a migration
  // is actually pending. History is stable across most boots, so this avoids
  // churning the pre-migration retention with identical copies on every restart.
  if (!config.backup.disabled && dbExisted && hasPendingMigrations(sqlite, migrationsFolder)) {
    try {
      const snap = createSnapshot(sqlite, 'pre-migration');
      console.log(`[backup] pre-migration snapshot written: ${snap}`);
    } catch (err) {
      console.error(`[backup] pre-migration snapshot FAILED — aborting migration to protect data: ${(err as Error).message}`);
      throw err;
    }
  }

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  // Ensure data invariants (settings row, worker ID, first admin)
  ensureDefaults(sqlite);
  // Recover pre-fix broken 1-on-1 DM threads (deleted partner's membership row
  // lost before the tombstone fix). Idempotent — safe no-op on every later boot.
  backfillOneOnOneDmMembership(sqlite);

  // Initialize Snowflake worker ID from persisted value
  const settings = sqlite.prepare('SELECT worker_id FROM instance_settings WHERE id = 1').get() as { worker_id: number } | undefined;
  if (settings?.worker_id !== undefined && settings.worker_id !== null) {
    setWorkerId(settings.worker_id);
    console.log(`Snowflake worker ID: ${settings.worker_id}`);
  } else {
    throw new Error('Snowflake worker_id not found in instance_settings — migration failed');
  }

  console.log(`Database initialized at ${config.dbPath}`);
  return db;
}

export type DB = ReturnType<typeof initDatabase>;

let db: DB;

export function getDb(): DB {
  if (!db) {
    db = initDatabase();
  }
  return db;
}

export function getRawDb(): Database.Database {
  return sqlite;
}

export function closeDatabase(): void {
  if (sqlite) {
    sqlite.close();
  }
}

export { schema };
