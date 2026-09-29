import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

it('applies notification settings after an already-migrated upstream database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-notification-upgrade-'));
  const db = new Database(':memory:');
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
    const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 20);
    fs.mkdirSync(path.join(dir, 'meta'));
    fs.writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      fs.copyFileSync(path.join(migrationsFolder, entry.tag + '.sql'), path.join(dir, entry.tag + '.sql'));
    }
    migrate(drizzle(db), { migrationsFolder: dir });
    // Drizzle gates upgrades by timestamp, not by the filename or journal index.
    migrate(drizzle(db), { migrationsFolder });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('notification_settings'))
      .toEqual({ name: 'notification_settings' });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true });
  }
});
