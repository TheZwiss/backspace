import fs from 'fs';
import path from 'path';
import { and, eq, inArray, isNotNull, isNull, lt, lte } from 'drizzle-orm';
import { FileStore } from '@tus/file-store';
import { config } from '../config.js';
import { getDb, getRawDb, schema } from '../db/index.js';
import { deleteUploadFile, deleteAttachmentFiles } from './fileCleanup.js';
import { generateSnowflake } from './snowflake.js';
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

/** Attachment records whose message_id or dm_message_id references a deleted message. */
function getDanglingAttachments(): { id: string; filename: string; size: number }[] {
  const rawDb = getRawDb();

  // Space message attachments with dangling references
  const danglingSpace = rawDb.prepare(`
    SELECT a.id, a.filename, a.size
    FROM attachments a
    LEFT JOIN messages m ON a.message_id = m.id
    WHERE a.message_id IS NOT NULL AND m.id IS NULL
  `).all() as { id: string; filename: string; size: number }[];

  // DM message attachments with dangling references
  const danglingDm = rawDb.prepare(`
    SELECT a.id, a.filename, a.size
    FROM attachments a
    LEFT JOIN dm_messages dm ON a.dm_message_id = dm.id
    WHERE a.dm_message_id IS NOT NULL AND dm.id IS NULL
  `).all() as { id: string; filename: string; size: number }[];

  return [...danglingSpace, ...danglingDm];
}

/**
 * Threshold for the `staleTusSessions` count exposed via `getStorageStats()`.
 * Distinct from `tusStragglerSweepMs` (defensive sweep, default 48h) and from
 * the configurable `maxAgeHours` of the admin cleanup route — this is purely
 * the "how many entries look abandoned right now?" display threshold. An
 * active upload writes chunks often, so a 1h+ gap is a strong signal the user
 * walked away (paused/crashed/discarded without DELETE).
 */
const STALE_TUS_DISPLAY_THRESHOLD_MS = 60 * 60 * 1000;

export function getStorageStats(): StorageStats {
  const diskFiles = getDiskFiles();
  const referenced = getReferencedFilenames();
  const unlinked = getUnlinkedAttachments();
  const dangling = getDanglingAttachments();
  const staleTus = getStaleTusInfo(STALE_TUS_DISPLAY_THRESHOLD_MS);

  const danglingFilenames = new Set<string>();
  let danglingSize = 0;
  for (const att of dangling) {
    danglingFilenames.add(path.basename(att.filename));
    danglingSize += att.size;
  }

  let totalSize = 0;
  let referencedSize = 0;
  let orphanedFiles = 0;
  let orphanedSize = 0;
  let danglingFilesOnDisk = 0;
  const breakdownMap = new Map<string, { count: number; size: number }>();

  for (const file of diskFiles) {
    totalSize += file.size;
    const type = classifyFile(file.filename);
    const entry = breakdownMap.get(type) || { count: 0, size: 0 };
    entry.count++;
    entry.size += file.size;
    breakdownMap.set(type, entry);

    if (danglingFilenames.has(file.filename)) {
      // File is on disk but its attachment record points to a deleted message
      danglingFilesOnDisk++;
    } else if (referenced.has(file.filename)) {
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
    referencedFiles: diskFiles.length - orphanedFiles - danglingFilesOnDisk,
    referencedSize,
    orphanedFiles,
    orphanedSize,
    unlinkedAttachments: unlinked.length,
    unlinkedSize,
    danglingAttachments: dangling.length,
    danglingSize,
    staleTusSessions: staleTus.count,
    staleTusSize: staleTus.size,
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

  // Phase 3: Delete dangling attachment records (message_id / dm_message_id
  // points to a message that no longer exists) and their files from disk.
  const dangling = getDanglingAttachments();
  for (const att of dangling) {
    if (!dryRun) {
      try {
        deleteUploadFile(att.filename);
        db.delete(schema.attachments)
          .where(eq(schema.attachments.id, att.id))
          .run();
      } catch (err: any) {
        errors.push(`Failed to clean up dangling attachment ${att.id}: ${err.message}`);
        continue;
      }
    }
    deletedFiles++;
    freedBytes += att.size;
    deletedAttachmentRecords++;
  }

  return {
    dryRun,
    deletedFiles,
    freedBytes,
    deletedAttachmentRecords,
    errors,
  };
}

export function cleanupOldMedia(maxAgeDays: number, dryRun: boolean): CleanupResult {
  const db = getDb();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const profileReferenced = getProfileReferencedFilenames();
  const errors: string[] = [];
  let deletedFiles = 0;
  let freedBytes = 0;
  let deletedAttachmentRecords = 0;

  // Find message attachments older than the cutoff
  const rawDb = getRawDb();
  const oldMedia = rawDb.prepare(`
    SELECT id, filename, size FROM attachments
    WHERE (message_id IS NOT NULL OR dm_message_id IS NOT NULL)
      AND created_at < ?
  `).all(cutoff) as { id: string; filename: string; size: number }[];

  for (const att of oldMedia) {
    // Never delete files currently used as profile images
    if (profileReferenced.has(path.basename(att.filename))) continue;

    if (!dryRun) {
      try {
        deleteUploadFile(att.filename);
        db.delete(schema.attachments)
          .where(eq(schema.attachments.id, att.id))
          .run();
      } catch (err: any) {
        errors.push(`Failed to delete old media ${att.id}: ${err.message}`);
        continue;
      }
    }
    deletedFiles++;
    freedBytes += att.size;
    deletedAttachmentRecords++;
  }

  return { dryRun, deletedFiles, freedBytes, deletedAttachmentRecords, errors };
}

/**
 * Delete expired federation outbox entries (expiresAt < now).
 * Returns the number of rows deleted.
 */
export function cleanupFederationOutbox(): number {
  const db = getDb();
  const result = db.delete(schema.federationOutbox)
    .where(lt(schema.federationOutbox.expiresAt, Date.now()))
    .run();
  return result.changes;
}

/**
 * Delete federation mutation log entries older than `retentionDays` (default 90).
 * Returns the number of rows deleted.
 */
export function cleanupFederationMutationLog(retentionDays: number = 90): number {
  const db = getDb();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = db.delete(schema.federationMutationLog)
    .where(lt(schema.federationMutationLog.mutatedAt, cutoff))
    .run();
  return result.changes;
}

/**
 * Delete stale federation file queue entries:
 *   - completed entries older than 7 days
 *   - any entries whose expiresAt has passed (regardless of status)
 * Returns the total number of rows deleted.
 */
export function cleanupFederationFileQueue(): number {
  const db = getDb();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Completed entries older than 7 days
  const completed = db.delete(schema.federationFileQueue)
    .where(and(
      eq(schema.federationFileQueue.status, 'completed'),
      lt(schema.federationFileQueue.createdAt, sevenDaysAgo),
    ))
    .run();

  // Expired entries (any status)
  const expired = db.delete(schema.federationFileQueue)
    .where(lt(schema.federationFileQueue.expiresAt, Date.now()))
    .run();

  return completed.changes + expired.changes;
}

/**
 * Expire peer approval requests older than their expiresAt timestamp.
 *
 * Outbound rows: before deletion, fan out kind='expired' notifications to
 * each subscriber so the original requester(s) can see the terminal state on
 * next page load. Subscriber rows cascade-delete via FK when the parent row
 * is removed. No network call — the remote was never told about our queued
 * outbound request to begin with.
 *
 * Inbound rows: send a signed POST /peer/denied with reason='expired' to
 * the requesting origin so it can update its UI. Only delete the row if the
 * POST succeeded; otherwise keep it and retry on the next janitor cycle.
 *
 * No WebSocket broadcast is emitted on local expiry — offline users see the
 * notification on next GET /api/federation/peering-notifications, matching
 * the persistence guarantee of the notifications table.
 */
export async function cleanupExpiredApprovalRequests(): Promise<number> {
  const db = getDb();
  const expiredRequests = db
    .select()
    .from(schema.peerApprovalRequests)
    .where(lte(schema.peerApprovalRequests.expiresAt, Date.now()))
    .all();

  if (expiredRequests.length === 0) return 0;

  const { getOurOrigin, buildFederationHeaders } = await import('./federationAuth.js');
  const { connectionManager } = await import('../ws/handler.js');
  const ourOrigin = getOurOrigin();
  const now = Date.now();
  let deletedCount = 0;

  for (const req of expiredRequests) {
    if (req.direction === 'outbound') {
      // Outbound expiry: fan out kind='expired' notifications to subscribers,
      // then cascade-delete. No network call.
      const subs = db
        .select()
        .from(schema.peerApprovalSubscribers)
        .where(eq(schema.peerApprovalSubscribers.requestId, req.id))
        .all();
      for (const sub of subs) {
        db.insert(schema.peerApprovalNotifications)
          .values({
            id: generateSnowflake(),
            userId: sub.userId,
            kind: 'expired',
            peerOrigin: req.origin,
            triggerReason: sub.triggerReason,
            triggerTarget: sub.triggerTarget,
            createdAt: now,
            readAt: null,
          })
          .run();
        // Subscriber row is about to cascade-delete; if the user is online,
        // refresh their pending list AND notification list. Offline users see
        // both on next page load via the GET endpoints (persistence guarantee).
        connectionManager.sendToUser(sub.userId, {
          type: 'peering_notification_received' as const,
          kind: 'expired',
        });
        connectionManager.sendToUser(sub.userId, {
          type: 'peering_subscription_changed' as const,
        });
      }
      db.delete(schema.peerApprovalRequests)
        .where(eq(schema.peerApprovalRequests.id, req.id))
        .run();
      deletedCount++;
      continue;
    }

    // Inbound expiry: signed /peer/denied POST to origin; only delete on
    // success. Preserved verbatim from pre-branch behavior.
    if (!req.hmacSecret) {
      // CHECK constraint guarantees inbound rows have hmac_secret; defensive guard.
      console.warn(
        `[storage-janitor] Inbound approval-request ${req.id} missing hmac_secret — skipping expiry notification`,
      );
      continue;
    }

    const denialBody = JSON.stringify({
      origin: ourOrigin,
      reason: 'expired' as const,
      message: 'Request expired — no response from admin within 30 days',
    });
    const headers = buildFederationHeaders(denialBody, req.hmacSecret, ourOrigin);

    let sent = false;
    try {
      const response = await fetch(`${req.origin}/api/federation/peer/denied`, {
        method: 'POST',
        headers,
        body: denialBody,
        signal: AbortSignal.timeout(10_000),
      });
      sent = response.ok;
    } catch {
      // Network error — will retry next cycle
    }

    if (sent) {
      // No rejected peer record for expiry — origin can re-request
      db.delete(schema.peerApprovalRequests)
        .where(eq(schema.peerApprovalRequests.id, req.id))
        .run();
      deletedCount++;
    } else {
      console.warn(
        `[storage-janitor] Failed to send expiry denial to ${req.origin} — will retry next cycle`,
      );
    }
  }

  if (deletedCount > 0) {
    console.log(`[storage-janitor] Deleted ${deletedCount} expired peer_approval_requests rows`);
  }

  return deletedCount;
}

/**
 * Delete read peering notifications older than 30 days. Unread notifications
 * are never auto-cleaned — the user must explicitly read or dismiss them.
 */
const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function cleanupReadPeeringNotifications(): number {
  const db = getDb();
  const cutoff = Date.now() - NOTIFICATION_RETENTION_MS;
  const result = db
    .delete(schema.peerApprovalNotifications)
    .where(
      and(
        isNotNull(schema.peerApprovalNotifications.readAt),
        lte(schema.peerApprovalNotifications.readAt, cutoff),
      ),
    )
    .run();
  if (result.changes > 0) {
    console.log(`[storage-janitor] Deleted ${result.changes} read peering notifications older than 30 days`);
  }
  return result.changes;
}

/**
 * Hard-delete DM channels that were soft-deleted more than 24 hours ago.
 * Cascades: reactions, embeds, attachments (files + DB rows), messages,
 * members, outbox entries, mutation log entries, file queue entries, then the channel.
 * Returns the number of channels purged.
 */
export function cleanupSoftDeletedDmChannels(): number {
  const db = getDb();
  const gracePeriodMs = 24 * 60 * 60 * 1000; // 24 hours
  const cutoff = Date.now() - gracePeriodMs;

  const expired = db
    .select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(
      and(
        isNotNull(schema.dmChannels.deletedAt),
        lt(schema.dmChannels.deletedAt, cutoff),
      ),
    )
    .all();

  if (expired.length === 0) return 0;

  let purged = 0;

  for (const channel of expired) {
    try {
      // Get message IDs and attachment filenames before deletion
      const msgIds = db.select({ id: schema.dmMessages.id })
        .from(schema.dmMessages)
        .where(eq(schema.dmMessages.dmChannelId, channel.id))
        .all()
        .map(m => m.id);

      const filesToDelete: string[] = [];
      if (msgIds.length > 0) {
        const attachments = db.select({ filename: schema.attachments.filename })
          .from(schema.attachments)
          .where(inArray(schema.attachments.dmMessageId, msgIds))
          .all();
        filesToDelete.push(...attachments.map(a => a.filename));
      }

      db.transaction((tx) => {
        if (msgIds.length > 0) {
          // Delete reactions
          tx.delete(schema.dmReactions)
            .where(inArray(schema.dmReactions.dmMessageId, msgIds))
            .run();

          // Delete embeds
          tx.delete(schema.embeds)
            .where(inArray(schema.embeds.dmMessageId, msgIds))
            .run();

          // Delete attachments (DB rows)
          tx.delete(schema.attachments)
            .where(inArray(schema.attachments.dmMessageId, msgIds))
            .run();

          // Delete file queue entries
          tx.delete(schema.federationFileQueue)
            .where(inArray(schema.federationFileQueue.dmMessageId, msgIds))
            .run();
        }

        // Delete messages
        tx.delete(schema.dmMessages)
          .where(eq(schema.dmMessages.dmChannelId, channel.id))
          .run();

        // Delete members (should be 0, defensive)
        tx.delete(schema.dmMembers)
          .where(eq(schema.dmMembers.dmChannelId, channel.id))
          .run();

        // Delete read states
        tx.delete(schema.readStates)
          .where(eq(schema.readStates.channelId, channel.id))
          .run();

        // Delete federation outbox entries
        tx.delete(schema.federationOutbox)
          .where(eq(schema.federationOutbox.contextId, channel.id))
          .run();

        // Delete mutation log entries
        tx.delete(schema.federationMutationLog)
          .where(eq(schema.federationMutationLog.contextId, channel.id))
          .run();

        // Delete the channel itself
        tx.delete(schema.dmChannels)
          .where(eq(schema.dmChannels.id, channel.id))
          .run();
      });

      // Clean up files from disk (outside transaction — filesystem ops are idempotent)
      deleteAttachmentFiles(filesToDelete.map(f => ({ filename: f })));

      purged++;
    } catch (err) {
      console.error(`[storage-janitor] Failed to purge soft-deleted DM channel ${channel.id}:`, err);
    }
  }

  if (purged > 0) {
    console.log(`[storage-janitor] Purged ${purged} soft-deleted DM channels`);
  }

  return purged;
}

// ── Tus-specific janitor functions ──────────────────────────────────────────
// Lazily construct (and cache) a FileStore pointed at config.tusUploadDir so
// we don't re-instantiate it on every janitor tick. The store is only used
// for its deleteExpired() method — we never serve uploads through it.
let cachedTusStore: FileStore | null = null;
function getTusStore(): FileStore {
  if (!cachedTusStore) {
    cachedTusStore = new FileStore({
      directory: config.tusUploadDir,
      expirationPeriodInMilliseconds: config.tusExpirationMs,
    });
  }
  return cachedTusStore;
}

/**
 * Tus's own expiration sweep — removes uploads whose creation_date sidecar
 * is past the configured expirationPeriodInMilliseconds. Cheap when nothing
 * has expired (one directory listing). Returns the number of removed entries.
 */
export async function cleanupTusUploads(): Promise<{ removed: number }> {
  const store = getTusStore();
  const removed = await store.deleteExpired();
  return { removed: typeof removed === 'number' ? removed : 0 };
}

/**
 * Walk `config.tusUploadDir`, yielding `{ name, full, size, mtimeMs }` for each
 * regular file matching `predicate`. Tolerates missing dir (yields nothing) and
 * skips entries whose `statSync` throws (e.g. file vanished mid-walk).
 *
 * Shared between the unconditional straggler sweep, the admin-driven
 * stale-session cleanup, and the stats helper. Centralising the iteration
 * keeps the .tus/ semantics (which entries count as "files we care about") in
 * exactly one place.
 */
interface TusEntry {
  name: string;
  full: string;
  size: number;
  mtimeMs: number;
}

function walkTusDir(predicate: (entry: TusEntry) => boolean): TusEntry[] {
  if (!fs.existsSync(config.tusUploadDir)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(config.tusUploadDir);
  } catch {
    return [];
  }
  const out: TusEntry[] = [];
  for (const name of names) {
    const full = path.join(config.tusUploadDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const entry: TusEntry = { name, full, size: stat.size, mtimeMs: stat.mtimeMs };
    if (predicate(entry)) out.push(entry);
  }
  return out;
}

/**
 * Inspect `.tus/` for entries whose mtime is older than `thresholdMs`. Returns
 * an aggregate snapshot — count, total bytes, oldest mtime — without touching
 * any files. Used by `getStorageStats()` to surface a count of "abandoned"
 * tus sessions in the admin UI, and by the admin route as a dry-run primitive.
 *
 * "Stale" here is purely mtime-based and counts both payloads and `.json`
 * sidecars; the conservative threshold (1h) used by `getStorageStats` matches
 * the intuition that an active upload writes chunks frequently, so a 1h+ gap
 * means the user genuinely walked away.
 */
export function getStaleTusInfo(thresholdMs: number): { count: number; size: number; oldestAt: number | null } {
  const cutoff = Date.now() - thresholdMs;
  let count = 0;
  let size = 0;
  let oldestAt: number | null = null;
  walkTusDir((entry) => {
    if (entry.mtimeMs >= cutoff) return false;
    count += 1;
    size += entry.size;
    if (oldestAt === null || entry.mtimeMs < oldestAt) oldestAt = entry.mtimeMs;
    return false; // we don't need the returned array, just side-effects
  });
  return { count, size, oldestAt };
}

/**
 * Admin-driven sweep of stale tus sessions. Walks `.tus/`, finds entries with
 * mtime older than `thresholdMs`, optionally unlinks each one, and returns an
 * aggregate result. In `dryRun=true` mode no files are touched. Per-file
 * unlink errors are collected (not thrown) so a single bad entry can't abort
 * the whole sweep.
 *
 * Note that `.tus/` holds *pairs* (payload + `.json` sidecar) per session, but
 * we treat each file independently — the sidecar's mtime is updated by
 * `@tus/file-store` on every PATCH, so payload + sidecar move together; if the
 * pair is genuinely abandoned, both are stale and both get reaped. No need for
 * pair reconciliation.
 */
export function cleanupStaleTusSessions(
  thresholdMs: number,
  dryRun: boolean,
): { deletedFiles: number; freedBytes: number; errors: string[] } {
  const cutoff = Date.now() - thresholdMs;
  const stale = walkTusDir((entry) => entry.mtimeMs < cutoff);
  const errors: string[] = [];
  let deletedFiles = 0;
  let freedBytes = 0;
  for (const entry of stale) {
    if (!dryRun) {
      try {
        fs.unlinkSync(entry.full);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to delete ${entry.name}: ${message}`);
        continue;
      }
    }
    deletedFiles += 1;
    freedBytes += entry.size;
  }
  return { deletedFiles, freedBytes, errors };
}

/**
 * Defensive sweep of `${config.tusUploadDir}`: any file (payload OR sidecar)
 * whose mtime is older than `thresholdMs` (default `config.tusStragglerSweepMs`,
 * 48 h) is unlinked. Covers the rare case where a tus crash left an orphan
 * that deleteExpired() doesn't recognize — e.g. a payload without sidecar (so
 * creation_date is unknown), or a sidecar without payload (so getUpload()
 * rejects).
 *
 * Janitor-tick contract preserved: returns `{ removed }` with the count of
 * files actually unlinked. Internally delegates to `cleanupStaleTusSessions`.
 */
export function cleanupTusStragglers(thresholdMs: number = config.tusStragglerSweepMs): { removed: number } {
  const result = cleanupStaleTusSessions(thresholdMs, false);
  return { removed: result.deletedFiles };
}

// cleanupStorage is expensive (full disk scan + DB joins) so we run it at
// most once per 24h rather than on every janitor tick.
const STORAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastStorageCleanupAt = 0;

/**
 * Run all periodic federation/GC cleanup tasks:
 *  - Expired outbox entries
 *  - Old mutation log entries
 *  - Stale file queue entries
 *  - Soft-deleted DM channels past grace period
 *  - Once-per-day: cleanupStorage (orphan files + unlinked + dangling)
 */
export async function runFederationJanitor(): Promise<void> {
  try {
    const outbox = cleanupFederationOutbox();
    const mutLog = cleanupFederationMutationLog();
    const fileQ = cleanupFederationFileQueue();
    const dmGc = cleanupSoftDeletedDmChannels();

    const total = outbox + mutLog + fileQ + dmGc;
    if (total > 0) {
      console.log(
        `[storage-janitor] Federation GC sweep: outbox=${outbox} mutationLog=${mutLog} fileQueue=${fileQ} dmChannels=${dmGc}`,
      );
    }

    // Expire approval requests:
    //   - Outbound rows fan out kind='expired' notifications to subscribers
    //     before cascade-delete (local DB only).
    //   - Inbound rows send a signed /peer/denied POST to the requesting
    //     origin; only delete on success, otherwise retry next cycle.
    // Then sweep read peering notifications older than 30 days.
    try {
      const approvalExpired = await cleanupExpiredApprovalRequests();
      if (approvalExpired > 0) {
        console.log(`[storage-janitor] Expired ${approvalExpired} peer approval request(s)`);
      }
      cleanupReadPeeringNotifications();
    } catch (err) {
      console.error('[storage-janitor] Approval request expiry error:', err);
    }

    // Tus expiration sweep — every tick. Removes tus uploads whose
    // creation_date sidecar is past config.tusExpirationMs (24h default).
    // Cheap when nothing has expired (one directory listing).
    try {
      await cleanupTusUploads();
    } catch (err) {
      console.warn('[storage-janitor] cleanupTusUploads failed:', err);
    }

    // Tus straggler sweep — every tick. Defensive removal of payload/sidecar
    // files in .tus/ whose mtime is older than config.tusStragglerSweepMs
    // (48h default). Catches orphans that deleteExpired() can't recognize
    // (payload without sidecar, sidecar without payload).
    try {
      cleanupTusStragglers();
    } catch (err) {
      console.warn('[storage-janitor] cleanupTusStragglers failed:', err);
    }

    // Once-per-day storage cleanup. Sweeps orphan disk files (unreferenced
    // by any DB row) + unlinked attachments (uploaded but never attached
    // to a message past the 1h grace) + dangling attachment rows. Backs up
    // the tus POST_FINISH atomicity guarantees in routes/files.ts.
    const now = Date.now();
    if (now - lastStorageCleanupAt >= STORAGE_CLEANUP_INTERVAL_MS) {
      lastStorageCleanupAt = now;
      try {
        const result = cleanupStorage(false);
        if (result.deletedFiles > 0 || result.deletedAttachmentRecords > 0 || result.errors.length > 0) {
          console.log(
            `[storage-janitor] Daily storage sweep: deletedFiles=${result.deletedFiles} freedBytes=${result.freedBytes} deletedAttachmentRecords=${result.deletedAttachmentRecords} errors=${result.errors.length}`,
          );
        }
      } catch (err) {
        console.error('[storage-janitor] Storage cleanup error:', err);
      }
    }
  } catch (err) {
    console.error('[storage-janitor] Federation GC sweep error:', err);
  }
}
