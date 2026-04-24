import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import * as schema from './schema.js';
import { ensureDefaults } from './migrate.js';
import { setWorkerId } from '../utils/snowflake.js';
import { mkdirSync } from 'fs';
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
  sqlite = new Database(config.dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Apply any pending Drizzle migrations
  const migrationsFolder = resolve(__dirname, '../../drizzle');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  // Ensure data invariants (settings row, worker ID, first admin)
  ensureDefaults(sqlite);

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
