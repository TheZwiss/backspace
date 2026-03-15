import fs from 'fs';
import path from 'path';
import { eq, isNotNull } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { deleteUploadFile } from './fileCleanup.js';
import type { StorageStats, StorageBreakdown, OrphanedFile, CleanupResult } from '@backspace/shared';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a', '.opus']);
const DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.json', '.xml']);

/** 1-hour threshold: attachments uploaded but never linked to a message */
const UNLINKED_AGE_MS = 60 * 60 * 1000;

function classifyFile(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (DOC_EXTS.has(ext)) return 'document';
  return 'other';
}

interface DiskFile {
  filename: string;
  size: number;
  modifiedAt: number;
}

function getDiskFiles(): DiskFile[] {
  try {
    const entries = fs.readdirSync(config.uploadDir, { withFileTypes: true });
    const files: DiskFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(path.join(config.uploadDir, entry.name));
        files.push({
          filename: entry.name,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      } catch {
        // Skip files that vanished between readdir and stat
      }
    }
    return files;
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Filenames referenced by user/space profiles (avatars, banners, icons). */
function getProfileReferencedFilenames(): Set<string> {
  const db = getDb();
  const referenced = new Set<string>();

  // User avatars
  const avatarRows = db.select({ avatar: schema.users.avatar })
    .from(schema.users)
    .where(isNotNull(schema.users.avatar))
    .all();
  for (const row of avatarRows) {
    if (row.avatar) referenced.add(path.basename(row.avatar));
  }

  // User banners
  const bannerRows = db.select({ banner: schema.users.banner })
    .from(schema.users)
    .where(isNotNull(schema.users.banner))
    .all();
  for (const row of bannerRows) {
    if (row.banner) referenced.add(path.basename(row.banner));
  }

  // Space icons
  const iconRows = db.select({ icon: schema.spaces.icon })
    .from(schema.spaces)
    .where(isNotNull(schema.spaces.icon))
    .all();
  for (const row of iconRows) {
    if (row.icon) referenced.add(path.basename(row.icon));
  }

  // Space banners
  const spaceBannerRows = db.select({ banner: schema.spaces.banner })
    .from(schema.spaces)
    .where(isNotNull(schema.spaces.banner))
    .all();
  for (const row of spaceBannerRows) {
    if (row.banner) referenced.add(path.basename(row.banner));
  }

  return referenced;
}

/** All filenames referenced anywhere: attachments + profiles. */
function getReferencedFilenames(): Set<string> {
  const db = getDb();
  const referenced = getProfileReferencedFilenames();

  // Attachment filenames
  const attachmentRows = db.select({ filename: schema.attachments.filename })
    .from(schema.attachments).all();
  for (const row of attachmentRows) {
    referenced.add(path.basename(row.filename));
  }

  // Attachment thumbnails
  const thumbRows = db.select({ thumbnailFilename: schema.attachments.thumbnailFilename })
    .from(schema.attachments)
    .where(isNotNull(schema.attachments.thumbnailFilename))
    .all();
  for (const row of thumbRows) {
    if (row.thumbnailFilename) referenced.add(path.basename(row.thumbnailFilename));
  }

  return referenced;
}

function getUnlinkedAttachments(): { id: string; filename: string; thumbnailFilename: string | null; size: number }[] {
  const db = getDb();
  const cutoff = Date.now() - UNLINKED_AGE_MS;
  const profileReferenced = getProfileReferencedFilenames();

  // Attachments with no message_id AND no dm_message_id, older than 1 hour,
  // excluding files currently used as profile images (avatars, banners, icons)
  const rows = db.select({
    id: schema.attachments.id,
    filename: schema.attachments.filename,
    thumbnailFilename: schema.attachments.thumbnailFilename,
    size: schema.attachments.size,
    messageId: schema.attachments.messageId,
    dmMessageId: schema.attachments.dmMessageId,
    createdAt: schema.attachments.createdAt,
  }).from(schema.attachments).all();

  return rows.filter(r =>
    r.messageId === null && r.dmMessageId === null && r.createdAt < cutoff
    && !profileReferenced.has(path.basename(r.filename))
  ).map(r => ({
    id: r.id,
    filename: r.filename,
    thumbnailFilename: r.thumbnailFilename,
    size: r.size,
  }));
}

export function getStorageStats(): StorageStats {
  const diskFiles = getDiskFiles();
  const referenced = getReferencedFilenames();
  const unlinked = getUnlinkedAttachments();

  let totalSize = 0;
  let referencedSize = 0;
  let orphanedFiles = 0;
  let orphanedSize = 0;
  const breakdownMap = new Map<string, { count: number; size: number }>();

  for (const file of diskFiles) {
    totalSize += file.size;
    const type = classifyFile(file.filename);
    const entry = breakdownMap.get(type) || { count: 0, size: 0 };
    entry.count++;
    entry.size += file.size;
    breakdownMap.set(type, entry);

    if (referenced.has(file.filename)) {
      referencedSize += file.size;
    } else {
      orphanedFiles++;
      orphanedSize += file.size;
    }
  }

  let unlinkedSize = 0;
  for (const att of unlinked) {
    unlinkedSize += att.size;
  }

  const breakdown: StorageBreakdown[] = [];
  for (const [type, data] of breakdownMap) {
    breakdown.push({ type, count: data.count, size: data.size });
  }
  breakdown.sort((a, b) => b.size - a.size);

  return {
    totalFiles: diskFiles.length,
    totalSize,
    referencedFiles: diskFiles.length - orphanedFiles,
    referencedSize,
    orphanedFiles,
    orphanedSize,
    unlinkedAttachments: unlinked.length,
    unlinkedSize,
    breakdown,
  };
}

export function getOrphanedFiles(): OrphanedFile[] {
  const diskFiles = getDiskFiles();
  const referenced = getReferencedFilenames();

  const orphans: OrphanedFile[] = [];
  for (const file of diskFiles) {
    if (!referenced.has(file.filename)) {
      orphans.push({
        filename: file.filename,
        size: file.size,
        modifiedAt: file.modifiedAt,
      });
    }
  }

  orphans.sort((a, b) => b.size - a.size);
  return orphans;
}

export function cleanupStorage(dryRun: boolean): CleanupResult {
  const db = getDb();
  const orphans = getOrphanedFiles();
  const unlinked = getUnlinkedAttachments();
  const profileReferenced = getProfileReferencedFilenames();
  const errors: string[] = [];
  let deletedFiles = 0;
  let freedBytes = 0;
  let deletedAttachmentRecords = 0;

  // Phase 1: Delete orphaned disk files (not referenced by any DB record)
  for (const orphan of orphans) {
    if (!dryRun) {
      try {
        deleteUploadFile(orphan.filename);
      } catch (err: any) {
        errors.push(`Failed to delete ${orphan.filename}: ${err.message}`);
        continue;
      }
    }
    deletedFiles++;
    freedBytes += orphan.size;
  }

  // Phase 2: Clean up stale unlinked attachment records.
  // Files referenced by user/space profiles (avatars, banners, icons) are
  // preserved on disk — only the orphaned attachment DB record is removed.
  // Thumbnails are always deleted since profile images don't need them.
  for (const att of unlinked) {
    const fileInUseByProfile = profileReferenced.has(path.basename(att.filename));
    if (!dryRun) {
      try {
        if (!fileInUseByProfile) {
          deleteUploadFile(att.filename);
        } else if (att.thumbnailFilename) {
          // Main file is a profile image — keep it. But delete the thumbnail
          // since it's only useful for message attachments, and the attachment
          // record is about to be deleted (which would orphan the thumbnail).
          const thumbPath = path.join(config.uploadDir, path.basename(att.thumbnailFilename));
          try { fs.unlinkSync(thumbPath); } catch { /* may not exist */ }
        }
        db.delete(schema.attachments)
          .where(eq(schema.attachments.id, att.id))
          .run();
      } catch (err: any) {
        errors.push(`Failed to clean up attachment ${att.id}: ${err.message}`);
        continue;
      }
    }
    deletedAttachmentRecords++;
    if (!fileInUseByProfile) {
      freedBytes += att.size;
    }
  }

  return {
    dryRun,
    deletedFiles,
    freedBytes,
    deletedAttachmentRecords,
    errors,
  };
}
