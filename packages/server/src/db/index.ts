import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import * as schema from './schema.js';
import { runMigrations } from './migrate.js';
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
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      owner_id TEXT NOT NULL REFERENCES users(id),
      invite_code TEXT UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member',
      nickname TEXT,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      topic TEXT,
      position INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dm_channels (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dm_members (
      dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (dm_channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS dm_messages (
      id TEXT PRIMARY KEY,
      dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      content TEXT,
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
      dm_message_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(dm_message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#b9bbbe',
      position INTEGER DEFAULT 0,
      permissions TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS member_roles (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (server_id, user_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS server_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT,
      color TEXT,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS server_folder_members (
      folder_id TEXT NOT NULL REFERENCES server_folders(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      PRIMARY KEY (folder_id, server_id)
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

export function closeDatabase(): void {
  if (sqlite) {
    sqlite.close();
  }
}

export { schema };
