import fs from 'fs';
import path from 'path';
import { gte, inArray, lt, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';

/**
 * Game icon files: one immutable WebP per content hash under
 * `<uploadDir>/game-icons`, outside the top level the attachment janitor reads.
 * Removed by `cleanupGameIconAssets` below.
 */
export function gameIconAssetDir(): string {
  return path.join(config.uploadDir, 'game-icons');
}

export function gameIconAssetPath(id: string): string {
  return path.join(gameIconAssetDir(), `${id}.webp`);
}

/**
 * How long an account's claim on an icon lasts without being renewed. Every
 * upload of the same bytes renews it (`game_icons.created_at` is "last
 * uploaded"), and the desktop client uploads a game's icon again about once a
 * month while the game is played, so only an icon nobody used for a year goes.
 */
export const GAME_ICON_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * An asset younger than this is never removed: an upload writes its asset row
 * before the file and the account's claim, so an upload in progress holds a
 * fresh row.
 */
export const GAME_ICON_ASSET_GRACE_MS = 24 * 60 * 60 * 1000;

/** A temporary file a crashed upload left behind is removed after this long. */
const TEMP_FILE_AGE_MS = 60 * 60 * 1000;

export interface GameIconCleanupResult {
  deletedFiles: number;
  freedBytes: number;
  /** Account claims dropped for going unrenewed. */
  expiredClaims: number;
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
 * Drop the claims nobody renewed for a year, then the assets no remaining
 * claim names once they are past the grace period, and the temporary files of
 * uploads that never finished. Everything runs synchronously, so no upload
 * (which writes its rows without awaiting) runs between the scan and the
 * deletes.
 *
 * A claim that expires while its icon is still shown on someone's profile
 * leaves a missing image there until the owner's client uploads it again,
 * which it does the next time the game is played.
 */
export function cleanupGameIconAssets(dryRun: boolean, now: number = Date.now()): GameIconCleanupResult {
  const db = getDb();
  const result: GameIconCleanupResult = { deletedFiles: 0, freedBytes: 0, expiredClaims: 0, errors: [] };

  const claimCutoff = now - GAME_ICON_RETENTION_MS;
  result.expiredClaims = db.select({ n: sql<number>`count(*)` }).from(schema.gameIcons)
    .where(lt(schema.gameIcons.createdAt, claimCutoff)).get()?.n ?? 0;

  // Assets still claimed once the stale claims are gone
  const kept = db.selectDistinct({ id: schema.gameIcons.iconId }).from(schema.gameIcons)
    .where(gte(schema.gameIcons.createdAt, claimCutoff)).all().map((row) => row.id);
  const keptSet = new Set(kept);
  const candidates = db.select({ id: schema.gameIconAssets.id }).from(schema.gameIconAssets)
    .where(lt(schema.gameIconAssets.createdAt, now - GAME_ICON_ASSET_GRACE_MS)).all().map((row) => row.id).filter((id) => !keptSet.has(id));

  const removed: string[] = [];
  for (const id of candidates) {
    const filePath = gameIconAssetPath(id);
    const size = fileSize(filePath);
    if (!dryRun) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch (err) {
        result.errors.push(`Failed to delete game icon ${id}: ${(err as Error).message}`);
        continue;
      }
    }
    removed.push(id);
    if (size > 0) result.deletedFiles += 1;
    result.freedBytes += size;
  }

  if (!dryRun) {
    db.delete(schema.gameIcons).where(lt(schema.gameIcons.createdAt, claimCutoff)).run();
    // Chunked: SQLite caps the number of bound parameters in one statement.
    for (let start = 0; start < removed.length; start += 500) {
      db.delete(schema.gameIconAssets).where(inArray(schema.gameIconAssets.id, removed.slice(start, start + 500))).run();
    }
  }

  let names: string[];
  try {
    names = fs.readdirSync(gameIconAssetDir());
  } catch {
    names = [];
  }
  const known = new Set(db.select({ id: schema.gameIconAssets.id }).from(schema.gameIconAssets).all().map((row) => row.id));
  const removedSet = new Set(removed);
  for (const name of names) {
    const filePath = path.join(gameIconAssetDir(), name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < TEMP_FILE_AGE_MS) continue;
    const id = name.replace(/\.webp$/, '');
    // Stale temporary files, and files no asset row names (a row removed by hand, a failed publish)
    const stray = name.endsWith('.tmp') || (name.endsWith('.webp') && !known.has(id) && !removedSet.has(id));
    if (!stray) continue;
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
