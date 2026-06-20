import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { hashPassword, verifyPassword } from '../utils/auth.js';
import { remediateSeedAdmin } from './remediate-seed-admin.js';

async function freshDbWithUser(opts: {
  username: string; password: string; isAdmin: number; homeInstance: string | null;
}): Promise<Database.Database> {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT, display_name TEXT, password_hash TEXT,
    is_admin INTEGER DEFAULT 0, home_instance TEXT, created_at INTEGER
  )`);
  db.prepare(
    'INSERT INTO users (id, username, password_hash, is_admin, home_instance, created_at) VALUES (?,?,?,?,?,?)'
  ).run('1', opts.username, await hashPassword(opts.password), opts.isAdmin, opts.homeInstance, 1);
  return db;
}

describe('remediateSeedAdmin', () => {
  it('rotates the password when admin still uses admin123', async () => {
    const db = await freshDbWithUser({ username: 'admin', password: 'admin123', isAdmin: 1, homeInstance: null });
    const result = await remediateSeedAdmin(db);
    expect(result.action).toBe('rotated');
    expect(result.newPassword).toBeTruthy();
    const row = db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get() as { password_hash: string };
    expect(await verifyPassword('admin123', row.password_hash)).toBe(false);
    expect(await verifyPassword(result.newPassword!, row.password_hash)).toBe(true);
  });

  it('is a no-op when the password is already changed', async () => {
    const db = await freshDbWithUser({ username: 'admin', password: 'a-real-strong-pw', isAdmin: 1, homeInstance: null });
    const result = await remediateSeedAdmin(db);
    expect(result.action).toBe('noop');
  });

  it('ignores a federated user named admin', async () => {
    const db = await freshDbWithUser({ username: 'admin', password: 'admin123', isAdmin: 0, homeInstance: 'other.example' });
    const result = await remediateSeedAdmin(db);
    expect(result.action).toBe('skipped-no-admin');
  });
});
