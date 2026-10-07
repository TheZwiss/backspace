import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// initDatabase runs normalizeStoredPermissions at every boot. When the pass is
// about to rewrite a stored value it first takes the pre-migration snapshot,
// as the 1-on-1 DM key backfill does; on a database with nothing to rewrite
// it takes none.

const dirs: string[] = [];
const testConfig = { dbPath: '', backup: { disabled: false } };

vi.mock('../config.js', () => ({ config: testConfig }));
const createSnapshot = vi.fn((): string => 'snapshot.db');
vi.mock('../utils/backup.js', () => ({ createSnapshot }));

const { initDatabase, closeDatabase } = await import('./index.js');

const now = 1_700_000_000_000;

/** A database that has booted once (schema and defaults in place) and is closed again. */
function bootedDatabase(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-permission-boot-'));
  dirs.push(dir);
  testConfig.dbPath = path.join(dir, 'backspace.db');
  initDatabase();
  closeDatabase();
}

function withRawDb(fn: (db: Database.Database) => void): void {
  const db = new Database(testConfig.dbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function seedRole(db: Database.Database, permissions: string): void {
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES ('owner', 'owner', 'x', ?)").run(now);
  db.prepare("INSERT INTO spaces (id, name, owner_id, invite_code, visibility, created_at) VALUES ('s', 'S', 'owner', 'c', 'public', ?)").run(now);
  db.prepare("INSERT INTO roles (id, space_id, name, position, permissions, created_at) VALUES ('r', 's', 'r', 1, ?, ?)").run(permissions, now);
}

beforeEach(() => {
  createSnapshot.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('initDatabase and the stored permission pass', () => {
  it('takes the pre-migration snapshot before rewriting a stored permission value', () => {
    bootedDatabase();
    withRawDb((db) => seedRole(db, '0x10'));
    createSnapshot.mockImplementation(() => {
      // Still the old value: the snapshot holds what the pass is about to change.
      withRawDb((db) => {
        expect((db.prepare("SELECT permissions FROM roles WHERE id = 'r'").get() as { permissions: string }).permissions).toBe('0x10');
      });
      return 'snapshot.db';
    });

    initDatabase();

    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(createSnapshot).toHaveBeenCalledWith(expect.anything(), 'pre-migration');
    closeDatabase();
    withRawDb((db) => {
      expect((db.prepare("SELECT permissions FROM roles WHERE id = 'r'").get() as { permissions: string }).permissions).toBe('16');
    });
  });

  it('takes no snapshot when every stored permission value is canonical', () => {
    bootedDatabase();
    withRawDb((db) => seedRole(db, '16'));

    initDatabase();

    expect(createSnapshot).not.toHaveBeenCalled();
  });
});
