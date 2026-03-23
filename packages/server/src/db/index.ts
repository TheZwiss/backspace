import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import * as schema from './schema.js';
import { runMigrations } from './migrate.js';
import { setWorkerId } from '../utils/snowflake.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let sqlite: Database.Database;

function ensureDirectory(filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
}

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      avatar TEXT,
      status TEXT DEFAULT 'offline',
      custom_status TEXT,
      is_admin INTEGER DEFAULT 0,
      home_instance TEXT,
      home_user_id TEXT,
      replicated_instances TEXT DEFAULT '[]',
      banner TEXT,
      accent_color TEXT,
      avatar_color TEXT,
      bio TEXT,
      is_deleted INTEGER DEFAULT 0,
      discoverable INTEGER DEFAULT 1,
      profile_updated_at INTEGER,
      password_changed_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      banner TEXT,
      avatar_color TEXT,
      owner_id TEXT NOT NULL REFERENCES users(id),
      invite_code TEXT UNIQUE,
      visibility TEXT DEFAULT 'private',
      description TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS space_members (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname TEXT,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS channel_categories (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      topic TEXT,
      position INTEGER DEFAULT 0,
      category_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      content TEXT,
      edited_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dm_channels (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dm_members (
      dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      closed INTEGER DEFAULT 0,
      PRIMARY KEY (dm_channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS dm_messages (
      id TEXT PRIMARY KEY,
      dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      reply_to_id TEXT REFERENCES dm_messages(id) ON DELETE SET NULL,
      content TEXT,
      edited_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      dm_message_id TEXT REFERENCES dm_messages(id) ON DELETE CASCADE,
      uploader_id TEXT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      thumbnail_filename TEXT,
      width INTEGER,
      height INTEGER,
      duration REAL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS dm_reactions (
      id TEXT PRIMARY KEY,
      dm_message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(dm_message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#b9bbbe',
      position INTEGER DEFAULT 0,
      permissions TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS member_roles (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (space_id, user_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS channel_overrides (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      allow TEXT NOT NULL DEFAULT '0',
      deny TEXT NOT NULL DEFAULT '0',
      PRIMARY KEY (channel_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS read_states (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      last_read_message_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS space_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT,
      color TEXT,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS space_folder_members (
      folder_id TEXT NOT NULL REFERENCES space_folders(id) ON DELETE CASCADE,
      space_id TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      PRIMARY KEY (folder_id, space_id)
    );

    CREATE TABLE IF NOT EXISTS user_space_layout (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      layout TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS instance_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      instance_name TEXT DEFAULT 'Backspace',
      worker_id INTEGER,
      discovery_enabled INTEGER NOT NULL DEFAULT 1,
      max_bitrate_kbps INTEGER NOT NULL DEFAULT 20000,
      min_bitrate_kbps INTEGER NOT NULL DEFAULT 500,
      bitrate_step_kbps INTEGER NOT NULL DEFAULT 500,
      allowed_resolutions TEXT NOT NULL DEFAULT '540,720,1080',
      allowed_framerates TEXT NOT NULL DEFAULT '30,45,60',
      max_resolution INTEGER NOT NULL DEFAULT 1080,
      max_framerate INTEGER NOT NULL DEFAULT 60,
      registration_open INTEGER,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bans (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT,
      banned_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS join_requests (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS voice_restrictions (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      restriction_type TEXT NOT NULL,
      moderator_id TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, user_id, restriction_type)
    );
  `);
}

export function initDatabase() {
  ensureDirectory(config.dbPath);
  sqlite = new Database(config.dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  createTables(sqlite);
  runMigrations(sqlite);

  // Initialize Snowflake worker ID from persisted value (set by migration)
  const settings = sqlite.prepare('SELECT worker_id FROM instance_settings WHERE id = 1').get() as { worker_id: number } | undefined;
  if (settings?.worker_id !== undefined && settings.worker_id !== null) {
    setWorkerId(settings.worker_id);
    console.log(`Snowflake worker ID: ${settings.worker_id}`);
  } else {
    throw new Error('Snowflake worker_id not found in instance_settings — migration failed');
  }

  console.log(`Database initialized at ${config.dbPath}`);
  return drizzle(sqlite, { schema });
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
