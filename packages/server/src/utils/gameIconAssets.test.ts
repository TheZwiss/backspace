import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as schema from '../db/schema.js';

const settings = vi.hoisted(() => ({ uploadDir: '' }));
let db: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
vi.mock('../db/index.js', () => ({ getDb: () => db, schema }));
vi.mock('../config.js', () => ({ config: settings }));
import {
  cleanupGameIconAssets, gameIconAssetDir, gameIconAssetPath,
  GAME_ICON_ASSET_GRACE_MS, GAME_ICON_RETENTION_MS,
} from './gameIconAssets.js';

const NOW = 10 * GAME_ICON_RETENTION_MS;
const OLD_ASSET = NOW - GAME_ICON_ASSET_GRACE_MS - 1;
const idOf = (n: number) => n.toString(16).padStart(64, '0');

function addAsset(id: string, createdAt = OLD_ASSET, bytes = 10): void {
  db.insert(schema.gameIconAssets).values({ id, createdAt }).run();
  fs.writeFileSync(gameIconAssetPath(id), Buffer.alloc(bytes));
}
function claim(userId: string, id: string, createdAt: number): void {
  db.insert(schema.gameIcons).values({ userId, iconId: id, createdAt }).run();
}

beforeEach(async () => {
  settings.uploadDir = await mkdtemp(path.join(tmpdir(), 'backspace-game-icon-janitor-'));
  fs.mkdirSync(gameIconAssetDir(), { recursive: true });
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve('drizzle') });
  for (const id of ['alice', 'bob']) {
    sqlite.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', 1)").run(id, id);
  }
});
afterEach(async () => {
  sqlite.close();
  await rm(settings.uploadDir, { recursive: true, force: true });
});

describe('cleanupGameIconAssets', () => {
  it('keeps an icon someone renewed within the year, however old its file is', () => {
    addAsset(idOf(1));
    claim('alice', idOf(1), NOW - GAME_ICON_RETENTION_MS + 1000);
    const result = cleanupGameIconAssets(false, NOW);
    expect(result).toEqual({ deletedFiles: 0, freedBytes: 0, expiredClaims: 0, errors: [] });
    expect(fs.existsSync(gameIconAssetPath(idOf(1)))).toBe(true);
  });

  it('drops a claim nobody renewed for a year, and the asset with it', () => {
    addAsset(idOf(1));
    claim('alice', idOf(1), NOW - GAME_ICON_RETENTION_MS - 1);
    expect(cleanupGameIconAssets(true, NOW)).toEqual({ deletedFiles: 1, freedBytes: 10, expiredClaims: 1, errors: [] });
    expect(db.select().from(schema.gameIcons).all()).toHaveLength(1); // a dry run changes nothing
    expect(fs.existsSync(gameIconAssetPath(idOf(1)))).toBe(true);

    cleanupGameIconAssets(false, NOW);
    expect(db.select().from(schema.gameIcons).all()).toHaveLength(0);
    expect(db.select().from(schema.gameIconAssets).all()).toHaveLength(0);
    expect(fs.existsSync(gameIconAssetPath(idOf(1)))).toBe(false);
  });

  it('keeps a shared asset while one account still claims it', () => {
    addAsset(idOf(1));
    claim('alice', idOf(1), NOW - GAME_ICON_RETENTION_MS - 1);
    claim('bob', idOf(1), NOW - 1000);
    const result = cleanupGameIconAssets(false, NOW);
    expect(result.expiredClaims).toBe(1);
    expect(result.deletedFiles).toBe(0);
    expect(db.select().from(schema.gameIcons).all().map((row) => row.userId)).toEqual(['bob']);
    expect(fs.existsSync(gameIconAssetPath(idOf(1)))).toBe(true);
  });

  it('removes an unclaimed asset but not one inside the grace period', () => {
    addAsset(idOf(1));
    addAsset(idOf(2), NOW - GAME_ICON_ASSET_GRACE_MS + 1);
    cleanupGameIconAssets(false, NOW);
    expect(fs.existsSync(gameIconAssetPath(idOf(1)))).toBe(false);
    expect(fs.existsSync(gameIconAssetPath(idOf(2)))).toBe(true);
  });

  it('removes a row whose file is already gone', () => {
    db.insert(schema.gameIconAssets).values({ id: idOf(1), createdAt: OLD_ASSET }).run();
    expect(cleanupGameIconAssets(false, NOW).deletedFiles).toBe(0);
    expect(db.select().from(schema.gameIconAssets).all()).toHaveLength(0);
  });

  it('removes old temporary files and files no row names, but not fresh ones', () => {
    addAsset(idOf(1));
    claim('alice', idOf(1), NOW - 1000);
    const files = {
      stale: path.join(gameIconAssetDir(), `${idOf(2)}.webp.a.tmp`),
      fresh: path.join(gameIconAssetDir(), `${idOf(3)}.webp.b.tmp`),
      stray: path.join(gameIconAssetDir(), `${idOf(4)}.webp`),
      freshStray: path.join(gameIconAssetDir(), `${idOf(5)}.webp`),
    };
    for (const file of Object.values(files)) fs.writeFileSync(file, Buffer.alloc(5));
    const old = new Date(NOW - 2 * 60 * 60 * 1000);
    for (const file of [files.stale, files.stray]) fs.utimesSync(file, old, old);
    for (const file of [files.fresh, files.freshStray]) fs.utimesSync(file, new Date(NOW), new Date(NOW));

    const result = cleanupGameIconAssets(false, NOW);
    expect(result.deletedFiles).toBe(2);
    expect(fs.existsSync(files.stale)).toBe(false);
    expect(fs.existsSync(files.stray)).toBe(false);
    expect(fs.existsSync(files.fresh)).toBe(true);
    expect(fs.existsSync(files.freshStray)).toBe(true);
    expect(fs.existsSync(gameIconAssetPath(idOf(1)))).toBe(true);
  });
});
