import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, '../../drizzle');

function migratedDb(): Database.Database {
  const db = new Database(':memory:');
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const text = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    for (const stmt of text.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
  return db;
}

function plan(db: Database.Database, sql: string): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail);
}

describe('users.home_user_id index', () => {
  it('serves the identity lookups instead of scanning users', () => {
    const db = migratedDb();

    // resolveRelayActor / resolveLocalUser (routes/federation/identity.ts)
    const actor = plan(
      db,
      "SELECT * FROM users WHERE (home_user_id = 'h' OR (id = 'h' AND home_instance IS NULL)) AND is_deleted = 0",
    );
    expect(actor).toContain('SEARCH users USING INDEX idx_users_home_user_id (home_user_id=?)');
    expect(actor.some((d) => d.startsWith('SCAN users'))).toBe(false);

    // the pair lookup with a normalized home_instance (handlers/relay.ts sync filter)
    const pair = plan(
      db,
      "SELECT is_deleted FROM users WHERE home_user_id = 'h' AND lower(replace(replace(coalesce(home_instance, ''), 'https://', ''), 'http://', '')) = 'b.example'",
    );
    expect(pair).toEqual(['SEARCH users USING INDEX idx_users_home_user_id (home_user_id=?)']);
  });
});
