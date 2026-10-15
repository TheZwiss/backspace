import fs from 'fs';
import path from 'path';
import { inArray, isNotNull, like, lt } from 'drizzle-orm';
import { stickerIdOf } from '@backspace/shared/src/stickers.js';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';

/**
 * Sticker assets live in their own directory under the upload directory, one
 * immutable WebP per content hash. The attachment janitor reads only the top
 * level of the upload directory, so it never sees these files; they are
 * removed by `cleanupUnusedStickerAssets` below.
 */
export function stickerAssetDir(): string {
  return path.join(config.uploadDir, 'stickers');
}

export function stickerAssetPath(id: string): string {
  return path.join(stickerAssetDir(), `${id}.webp`);
}

export function stickerPreviewPath(id: string): string {
  return path.join(stickerAssetDir(), `${id}_preview.webp`);
}

/**
 * An asset younger than this is never removed. `sticker_assets.created_at` is
 * set again by every upload of the same bytes before the file is written, so
 * an upload in progress always holds a fresh row.
 */
export const STICKER_ASSET_GRACE_MS = 24 * 60 * 60 * 1000;

/** A temporary file a crashed upload left behind is removed after this long. */
const STICKER_TEMP_FILE_AGE_MS = 60 * 60 * 1000;

/**
 * Asset ids that something stored on this instance still names: a collection
 * entry, a sticker pack item, a sticker pack cover, a channel or DM message
 * whose content is a sticker token, or a channel or DM reaction that is one.
 * A token from another instance that happens to carry the same hash counts too,
 * which only ever keeps a file.
 */
export function getReferencedStickerIds(): Set<string> {
  const db = getDb();
  const ids = new Set<string>();
  for (const row of db.select({ id: schema.personalStickers.stickerId }).from(schema.personalStickers).all()) {
    ids.add(row.id);
  }
  for (const row of db.select({ id: schema.stickerPackItems.assetId }).from(schema.stickerPackItems).all()) {
    ids.add(row.id);
  }
  for (const row of db.select({ id: schema.stickerPacks.coverAssetId }).from(schema.stickerPacks).where(isNotNull(schema.stickerPacks.coverAssetId)).all()) {
    if (row.id) ids.add(row.id);
  }
  for (const row of db.select({ id: schema.stickerPackVersions.coverAssetId }).from(schema.stickerPackVersions).where(isNotNull(schema.stickerPackVersions.coverAssetId)).all()) {
    if (row.id) ids.add(row.id);
  }
  const values = [
    ...db.select({ value: schema.messages.content }).from(schema.messages)
      .where(like(schema.messages.content, 'sticker:%')).all(),
    ...db.select({ value: schema.dmMessages.content }).from(schema.dmMessages)
      .where(like(schema.dmMessages.content, 'sticker:%')).all(),
    ...db.select({ value: schema.reactions.emoji }).from(schema.reactions)
      .where(like(schema.reactions.emoji, 'sticker:%')).all(),
    ...db.select({ value: schema.dmReactions.emoji }).from(schema.dmReactions)
      .where(like(schema.dmReactions.emoji, 'sticker:%')).all(),
  ];
  for (const { value } of values) {
    const id = value ? stickerIdOf(value) : null;
    if (id) ids.add(id);
  }
  return ids;
}

export interface StickerCleanupResult {
  deletedFiles: number;
  freedBytes: number;
  errors: string[];
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Remove the assets nothing on this instance names any more (see
 * `getReferencedStickerIds`) once they are past the grace period, and the
 * temporary files of uploads that never finished.
 *
 * Synchronous from the reference scan to the last unlink, so no upload or
 * collect request runs in between: both write their rows without awaiting.
 *
 * A sticker sent only to a space hosted on another instance is not stored
 * here, so it does not keep its asset: once its sender removes it from their
 * collection and no local message or reaction uses it, that message on the
 * other instance shows a missing image. See docs/systems/uploads.md,
 * "Personal stickers".
 */
export function cleanupUnusedStickerAssets(dryRun: boolean, now: number = Date.now()): StickerCleanupResult {
  const db = getDb();
  const result: StickerCleanupResult = { deletedFiles: 0, freedBytes: 0, errors: [] };
  const referenced = getReferencedStickerIds();
  const candidates = db.select({ id: schema.stickerAssets.id }).from(schema.stickerAssets)
    .where(lt(schema.stickerAssets.createdAt, now - STICKER_ASSET_GRACE_MS)).all()
    .map(row => row.id)
    .filter(id => !referenced.has(id));

  for (const id of candidates) {
    const filePath = stickerAssetPath(id);
    const pPath = stickerPreviewPath(id);
    const size = fileSize(filePath) + fileSize(pPath);
    if (!dryRun) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch (err) {
        result.errors.push(`Failed to delete sticker ${id}: ${(err as Error).message}`);
        continue;
      }
      try {
        fs.rmSync(pPath, { force: true });
      } catch {
        // Preview file might not exist
      }
    }
    if (size > 0) result.deletedFiles += 1;
    result.freedBytes += size;
  }
  if (!dryRun) {
    // Chunked: SQLite caps the number of bound parameters in one statement.
    for (let start = 0; start < candidates.length; start += 500) {
      db.delete(schema.stickerAssets).where(inArray(schema.stickerAssets.id, candidates.slice(start, start + 500))).run();
    }
  }

  let names: string[];
  try {
    names = fs.readdirSync(stickerAssetDir());
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    const filePath = path.join(stickerAssetDir(), name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < STICKER_TEMP_FILE_AGE_MS) continue;
    if (!dryRun) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch (err) {
        result.errors.push(`Failed to delete ${name}: ${(err as Error).message}`);
        continue;
      }
    }
    result.deletedFiles += 1;
    result.freedBytes += stat.size;
  }
  return result;
}
