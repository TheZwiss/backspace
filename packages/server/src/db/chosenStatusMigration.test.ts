import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, '../../drizzle');
const CHOSEN_STATUS_MIGRATION = '0019_chosen_status.sql';

function apply(db: Database.Database, file: string): void {
  const text = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split(/-->\s*statement-breakpoint/)) {
    const clean = stmt.trim();
    if (clean) db.exec(clean);
  }
}

function insertUser(db: Database.Database, id: string, status: string, homeInstance: string | null, orphaned = 0): void {
  db.prepare(
    'INSERT INTO users (id, username, password_hash, status, home_instance, federation_home_orphaned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, id, 'x', status, homeInstance, orphaned, 1);
}

describe(`migration ${CHOSEN_STATUS_MIGRATION}`, () => {
  it("carries idle or dnd over for accounts that own their choice (native or detached) and defaults everyone else to online", () => {
    const db = new Database(':memory:');
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    expect(files).toContain(CHOSEN_STATUS_MIGRATION);
    for (const f of files) {
      if (f === CHOSEN_STATUS_MIGRATION) break;
      apply(db, f);
    }

    insertUser(db, 'native-dnd', 'dnd', null);
    insertUser(db, 'native-idle', 'idle', null);
    insertUser(db, 'native-online', 'online', null);
    insertUser(db, 'native-offline', 'offline', null);
    insertUser(db, 'replicated-dnd', 'dnd', 'home.example');
    insertUser(db, 'detached-dnd', 'dnd', 'reset.example', 1);

    apply(db, CHOSEN_STATUS_MIGRATION);

    const rows = db.prepare('SELECT id, chosen_status AS chosen FROM users ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'detached-dnd', chosen: 'dnd' },
      { id: 'native-dnd', chosen: 'dnd' },
      { id: 'native-idle', chosen: 'idle' },
      { id: 'native-offline', chosen: 'online' },
      { id: 'native-online', chosen: 'online' },
      { id: 'replicated-dnd', chosen: 'online' },
    ]);
  });
});
