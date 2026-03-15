import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { thumbFilename } from './thumbnail.js';

/**
 * Delete a single uploaded file by its stored filename.
 * Uses path.basename() to prevent directory traversal attacks.
 * Tolerates ENOENT (file already gone) but logs other errors.
 * Also attempts to delete the corresponding thumbnail if one exists.
 */
export function deleteUploadFile(filename: string): void {
  const safeName = path.basename(filename);
  const filePath = path.join(config.uploadDir, safeName);
  try {
    fs.unlinkSync(filePath);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error(`Failed to delete upload file ${safeName}:`, err.message);
    }
  }

  // Also attempt to delete the thumbnail variant
  const thumbName = thumbFilename(safeName);
  const thumbPath = path.join(config.uploadDir, thumbName);
  try {
    fs.unlinkSync(thumbPath);
  } catch {
    // Thumbnail may not exist — that's fine
  }
}

/**
 * Delete multiple uploaded files from disk.
 * Accepts rows with a `filename` property (e.g. attachment query results).
 */
export function deleteAttachmentFiles(rows: { filename: string }[]): void {
  for (const row of rows) {
    deleteUploadFile(row.filename);
  }
}

/**
 * Delete the attachment DB record for a given filename, plus its thumbnail.
 * Used when profile images (avatars, banners, icons) are set or replaced —
 * the file reference moves to users/spaces tables, making the attachment
 * record unnecessary. Idempotent (no-op if record doesn't exist).
 */
export function deleteAttachmentByFilename(filename: string): void {
  const db = getDb();
  const safeName = path.basename(filename);

  // Read the record first to get the thumbnail filename before deleting
  const record = db.select({
    id: schema.attachments.id,
    thumbnailFilename: schema.attachments.thumbnailFilename,
  }).from(schema.attachments)
    .where(eq(schema.attachments.filename, safeName))
    .get();
  if (!record) return;

  // Delete thumbnail from disk (profile images don't need thumbnails)
  if (record.thumbnailFilename) {
    const thumbPath = path.join(config.uploadDir, path.basename(record.thumbnailFilename));
    try { fs.unlinkSync(thumbPath); } catch { /* may not exist */ }
  }

  // Delete the attachment record
  db.delete(schema.attachments)
    .where(eq(schema.attachments.id, record.id))
    .run();
}
