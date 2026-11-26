import fs from 'fs';
import path from 'path';
import { and, eq, inArray, isNotNull, like, lt, notInArray } from 'drizzle-orm';
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

const PURGED_PACK_STATUSES = ['deleted', 'blocked'] as const;

/**
 * Collects every asset ID attached to the given sticker packs (covers, version
 * covers, and version items) before those pack rows are removed or blocked.
 */
export function collectPackAssetIds(packIds: string[]): Set<string> {
  const ids = new Set<string>();
  if (packIds.length === 0) return ids;
  const db = getDb();

  for (const row of db.select({ id: schema.stickerPacks.coverAssetId })
    .from(schema.stickerPacks)
    .where(and(inArray(schema.stickerPacks.id, packIds), isNotNull(schema.stickerPacks.coverAssetId)))
    .all()) {
    if (row.id) ids.add(row.id);
  }
  for (const row of db.select({ id: schema.stickerPackVersions.coverAssetId })
    .from(schema.stickerPackVersions)
    .where(and(inArray(schema.stickerPackVersions.packId, packIds), isNotNull(schema.stickerPackVersions.coverAssetId)))
    .all()) {
    if (row.id) ids.add(row.id);
  }
  for (const row of db.select({ id: schema.stickerPackItems.assetId })
    .from(schema.stickerPackItems)
    .where(inArray(schema.stickerPackItems.packId, packIds))
    .all()) {
    ids.add(row.id);
  }
  return ids;
}

/**
 * Asset ids that something live on this instance still names: a personal
 * collection entry, a non-deleted/non-blocked sticker pack item or cover, a
 * channel or DM message whose content is a sticker token, or a channel or DM
 * reaction that is one.
 */
export function getReferencedStickerIds(): Set<string> {
  const db = getDb();
  const ids = new Set<string>();
  for (const row of db.select({ id: schema.personalStickers.stickerId }).from(schema.personalStickers).all()) {
    ids.add(row.id);
  }

  const livePackIds = db.select({ id: schema.stickerPacks.id })
    .from(schema.stickerPacks)
    .where(notInArray(schema.stickerPacks.status, [...PURGED_PACK_STATUSES]))
    .all()
    .map(r => r.id);

  if (livePackIds.length > 0) {
    for (const row of db.select({ id: schema.stickerPackItems.assetId })
      .from(schema.stickerPackItems)
      .where(and(
        inArray(schema.stickerPackItems.packId, livePackIds),
        eq(schema.stickerPackItems.status, 'active'),
      ))
      .all()) {
      ids.add(row.id);
    }
    for (const row of db.select({ id: schema.stickerPacks.coverAssetId })
      .from(schema.stickerPacks)
      .where(and(inArray(schema.stickerPacks.id, livePackIds), isNotNull(schema.stickerPacks.coverAssetId)))
      .all()) {
      if (row.id) ids.add(row.id);
    }
    for (const row of db.select({ id: schema.stickerPackVersions.coverAssetId })
      .from(schema.stickerPackVersions)
      .where(and(inArray(schema.stickerPackVersions.packId, livePackIds), isNotNull(schema.stickerPackVersions.coverAssetId)))
      .all()) {
      if (row.id) ids.add(row.id);
    }
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

function deleteCandidateAssets(candidates: string[], dryRun: boolean): StickerCleanupResult {
  const db = getDb();
  const result: StickerCleanupResult = { deletedFiles: 0, freedBytes: 0, errors: [] };
  const deletableRows: string[] = [];

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
      deletableRows.push(id);
    }
    if (size > 0) result.deletedFiles += 1;
    result.freedBytes += size;
  }

  if (!dryRun && deletableRows.length > 0) {
    // Chunked: SQLite caps the number of bound parameters in one statement.
    for (let start = 0; start < deletableRows.length; start += 500) {
      db.delete(schema.stickerAssets)
        .where(inArray(schema.stickerAssets.id, deletableRows.slice(start, start + 500)))
        .run();
    }
  }

  return result;
}

/**
 * Immediately removes any asset in `candidateIds` that has no remaining live
 * reference on this instance (personal collection, live sticker pack, message,
 * or reaction). Used when a pack is removed, locally blocked, or reconciled
 * after removal at the authoritative peer.
 */
export function cleanupUnreferencedStickerAssets(
  candidateIds: Iterable<string>,
  dryRun = false,
): StickerCleanupResult {
  const uniqueIds = [...new Set(candidateIds)];
  if (uniqueIds.length === 0) return { deletedFiles: 0, freedBytes: 0, errors: [] };
  const referenced = getReferencedStickerIds();
  const unreferenced = uniqueIds.filter(id => !referenced.has(id));
  return deleteCandidateAssets(unreferenced, dryRun);
}

/**
 * Remove the assets nothing on this instance names any more (see
 * `getReferencedStickerIds`) once they are past the grace period, and the
 * temporary files of uploads that never finished.
 */
export function cleanupUnusedStickerAssets(dryRun: boolean, now: number = Date.now()): StickerCleanupResult {
  const db = getDb();
  const referenced = getReferencedStickerIds();
  const candidates = db.select({ id: schema.stickerAssets.id }).from(schema.stickerAssets)
    .where(lt(schema.stickerAssets.createdAt, now - STICKER_ASSET_GRACE_MS)).all()
    .map(row => row.id)
    .filter(id => !referenced.has(id));

  const result = deleteCandidateAssets(candidates, dryRun);

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
