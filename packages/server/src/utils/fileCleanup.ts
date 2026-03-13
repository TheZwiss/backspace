import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
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
