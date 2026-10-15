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
import { cleanupUnusedStickerAssets, stickerAssetDir, stickerAssetPath, stickerPreviewPath, STICKER_ASSET_GRACE_MS } from './stickerAssets.js';

const NOW = 10 * STICKER_ASSET_GRACE_MS;
const OLD = NOW - STICKER_ASSET_GRACE_MS - 1;
const idOf = (n: number) => n.toString(16).padStart(64, '0');
const tokenOf = (id: string, origin = 'https://chat.test') => `sticker:${origin}/api/stickers/assets/${id}.webp`;

function addAsset(id: string, createdAt = OLD): void {
  db.insert(schema.stickerAssets).values({ id, createdAt }).run();
  fs.writeFileSync(stickerAssetPath(id), Buffer.alloc(10));
  fs.writeFileSync(stickerPreviewPath(id), Buffer.alloc(5));
}

beforeEach(async () => {
  settings.uploadDir = await mkdtemp(path.join(tmpdir(), 'backspace-sticker-janitor-'));
  fs.mkdirSync(stickerAssetDir(), { recursive: true });
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve('drizzle') });
  sqlite.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES ('alice', 'alice', 'x', 1)").run();
  sqlite.prepare("INSERT INTO spaces (id, name, owner_id, created_at) VALUES ('space', 'Space', 'alice', 1)").run();
  sqlite.prepare("INSERT INTO channels (id, space_id, name, type, position, created_at) VALUES ('channel', 'space', 'general', 'text', 0, 1)").run();
  sqlite.prepare("INSERT INTO dm_channels (id, created_at) VALUES ('dm', 1)").run();
});

afterEach(async () => {
  sqlite.close();
  await rm(settings.uploadDir, { recursive: true, force: true });
});

describe('cleanupUnusedStickerAssets', () => {
  it('keeps every asset something on this instance names and removes the rest', () => {
    for (let n = 1; n <= 7; n += 1) addAsset(idOf(n));
    db.insert(schema.personalStickers).values({ userId: 'alice', stickerId: idOf(1), name: 'Kept', createdAt: 1 }).run();
    sqlite.prepare("INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES ('m1', 'channel', 'alice', ?, 1)").run(tokenOf(idOf(2)));
    sqlite.prepare("INSERT INTO dm_messages (id, dm_channel_id, user_id, content, created_at) VALUES ('d1', 'dm', 'alice', ?, 1)").run(tokenOf(idOf(3), 'https://peer.test'));
    sqlite.prepare("INSERT INTO reactions (id, message_id, user_id, emoji, created_at) VALUES ('r1', 'm1', 'alice', ?, 1)").run(tokenOf(idOf(4)));
    sqlite.prepare("INSERT INTO dm_reactions (id, dm_message_id, user_id, emoji, created_at) VALUES ('r2', 'd1', 'alice', ?, 1)").run(tokenOf(idOf(5)));
    // Text that mentions an asset URL is not a sticker and keeps nothing.
    sqlite.prepare("INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES ('m2', 'channel', 'alice', ?, 1)").run(`look ${tokenOf(idOf(6))}`);

    const dry = cleanupUnusedStickerAssets(true, NOW);
    expect(dry).toEqual({ deletedFiles: 2, freedBytes: 30, errors: [] });
    expect(fs.existsSync(stickerAssetPath(idOf(6)))).toBe(true);
    expect(fs.existsSync(stickerPreviewPath(idOf(6)))).toBe(true);

    const result = cleanupUnusedStickerAssets(false, NOW);
    expect(result).toEqual({ deletedFiles: 2, freedBytes: 30, errors: [] });
    for (const n of [1, 2, 3, 4, 5]) {
      expect(fs.existsSync(stickerAssetPath(idOf(n)))).toBe(true);
      expect(fs.existsSync(stickerPreviewPath(idOf(n)))).toBe(true);
    }
    for (const n of [6, 7]) {
      expect(fs.existsSync(stickerAssetPath(idOf(n)))).toBe(false);
      expect(fs.existsSync(stickerPreviewPath(idOf(n)))).toBe(false);
    }
    expect(db.select().from(schema.stickerAssets).all().map(row => row.id).sort()).toEqual([1, 2, 3, 4, 5].map(idOf));
  });

  it('leaves assets inside the grace period alone', () => {
    addAsset(idOf(1), NOW - STICKER_ASSET_GRACE_MS + 1);
    expect(cleanupUnusedStickerAssets(false, NOW).deletedFiles).toBe(0);
    expect(fs.existsSync(stickerAssetPath(idOf(1)))).toBe(true);
  });

  it('removes a row whose file is already gone and old temporary files only', () => {
    db.insert(schema.stickerAssets).values({ id: idOf(1), createdAt: OLD }).run();
    const stale = path.join(stickerAssetDir(), `${idOf(2)}.webp.a.tmp`);
    const fresh = path.join(stickerAssetDir(), `${idOf(3)}.webp.b.tmp`);
    fs.writeFileSync(stale, Buffer.alloc(4));
    fs.writeFileSync(fresh, Buffer.alloc(4));
    fs.utimesSync(stale, new Date(0), new Date(0));
    fs.utimesSync(fresh, new Date(NOW), new Date(NOW));
    const result = cleanupUnusedStickerAssets(false, NOW);
    expect(result).toEqual({ deletedFiles: 1, freedBytes: 4, errors: [] });
    expect(db.select().from(schema.stickerAssets).all()).toEqual([]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
