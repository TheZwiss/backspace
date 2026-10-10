import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';

it('adds only sticker tables when upgrading an existing upstream database', async () => {
  const previous = await mkdtemp(path.join(tmpdir(), 'backspace-before-stickers-'));
  const sqlite = new Database(':memory:');
  try {
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as {
      entries: { tag: string }[];
    };
    expect(journal.entries.at(-1)?.tag).toBe('0027_personal_stickers');
    // Reproduce the actual pre-feature migration history, not a hand-written schema fixture.
    journal.entries.pop();
    await mkdir(path.join(previous, 'meta'));
    await writeFile(path.join(previous, 'meta/_journal.json'), JSON.stringify(journal));
    for (const { tag } of journal.entries) {
      await copyFile(path.join('drizzle', tag + '.sql'), path.join(previous, tag + '.sql'));
    }
    migrate(db, { migrationsFolder: previous });
    sqlite.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('existing-user', 'alice', 'test-hash', 1);
    const tables = () => sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string; sql: string }[];
    const before = tables();
    expect(before.map(row => row.name)).not.toContain('sticker_assets');

    migrate(db, { migrationsFolder: path.resolve('drizzle') });
    const after = tables();
    const added = after.filter(row => !before.some(old => old.name === row.name));
    expect(added.map(row => row.name)).toEqual(['personal_stickers', 'sticker_assets']);
    expect(after.filter(row => before.some(old => old.name === row.name))).toEqual(before);
    expect(sqlite.prepare('SELECT username FROM users WHERE id = ?').get('existing-user')).toEqual({ username: 'alice' });

    const id = 'a'.repeat(64);
    sqlite.prepare('INSERT INTO sticker_assets (id, created_at) VALUES (?, ?)').run(id, 2);
    const collect = sqlite.prepare('INSERT INTO personal_stickers (user_id, sticker_id, name, created_at) VALUES (?, ?, ?, ?)');
    collect.run('existing-user', id, 'Happy', 2);
    expect(() => collect.run('missing-user', id, 'Happy', 2)).toThrow(/FOREIGN KEY/);
    expect(() => collect.run('existing-user', 'missing-asset', 'Happy', 2)).toThrow(/FOREIGN KEY/);
    expect(() => collect.run('existing-user', id, 'Happy', 2)).toThrow(/UNIQUE/);
    sqlite.prepare('DELETE FROM users WHERE id = ?').run('existing-user');
    expect(sqlite.prepare('SELECT * FROM personal_stickers').all()).toEqual([]);
    expect(sqlite.prepare('SELECT id FROM sticker_assets').all()).toEqual([{ id }]);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    sqlite.close();
    await rm(previous, { recursive: true, force: true });
  }
});
