import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureDefaults } from './migrate.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE instance_settings (id integer PRIMARY KEY, worker_id integer, instance_id text, max_bitrate_kbps integer, min_bitrate_kbps integer, bitrate_step_kbps integer, allowed_resolutions text, allowed_framerates text, max_resolution integer, max_framerate integer, updated_at integer);
    CREATE TABLE users (id text PRIMARY KEY, is_admin integer DEFAULT 0, created_at integer);`);
  return db;
}

describe('ensureDefaults instance epoch', () => {
  it('mints an instance_id when null and is idempotent', () => {
    const db = freshDb();
    ensureDefaults(db);
    const first = (db.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as { instance_id: string }).instance_id;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    ensureDefaults(db);
    const second = (db.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as { instance_id: string }).instance_id;
    expect(second).toBe(first); // stable across boots
  });

  it('mints a different id for a separate fresh DB', () => {
    const a = freshDb(); ensureDefaults(a);
    const b = freshDb(); ensureDefaults(b);
    const idA = (a.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as { instance_id: string }).instance_id;
    const idB = (b.prepare('SELECT instance_id FROM instance_settings WHERE id = 1').get() as { instance_id: string }).instance_id;
    expect(idA).not.toBe(idB);
  });
});
