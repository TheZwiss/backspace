import fs from 'fs';
import { dirname } from 'path';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { cleanupStorage, cleanupStaleTusSessions, deleteOldestMedia } from './storageJanitor.js';
import type { CleanupResult, DiskPressureRun, DiskPressureStatus } from '@backspace/shared';

/**
 * Disk-pressure cleanup: when the filesystem holding the data directory is
 * nearly full, free space by deleting what matters least, in this order.
 *
 *  1. The safe cleanups: files no database row references, uploads that were
 *     never attached to a message, attachment rows whose message is gone, and
 *     stale tus sessions. Nothing a member can still see is lost.
 *  2. Only if the disk is still at or above the threshold: chat attachments,
 *     oldest first, never newer than `minAgeDays`, until usage falls below the
 *     target. The message text stays; the file and its attachment row go.
 *
 * `statfs` reports the whole filesystem, so on a small VPS the percentage is the
 * server's disk, not only this app's files. When something else (container
 * images, logs) is what filled it, the sweep frees what it can and stops at the
 * age floor rather than deleting recent content.
 *
 * Off until the instance owner turns it on (Settings > Storage): it deletes
 * members' files on its own. The settings live in `instance_settings`.
 */

export interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
}

export interface DiskPressureSettings {
  thresholdPercent: number;
  targetPercent: number;
  minAgeDays: number;
}

export interface DiskPressureDeps {
  readUsage: () => DiskUsage | null;
  cleanupSafe: () => CleanupResult;
  cleanupStaleTus: () => CleanupResult;
  evictOldest: (minAgeDays: number, shouldStop: () => boolean) => CleanupResult;
  now: () => number;
}

/** The percentage `df` prints: used / (used + space available to unprivileged users). */
export function readDiskUsage(dir: string): DiskUsage | null {
  try {
    const st = fs.statfsSync(dir);
    const used = (st.blocks - st.bfree) * st.bsize;
    const available = st.bavail * st.bsize;
    const total = used + available;
    if (!Number.isFinite(total) || total <= 0) return null;
    return { totalBytes: total, usedBytes: used };
  } catch {
    return null;
  }
}

export function usedPercent(usage: DiskUsage): number {
  return (usage.usedBytes / usage.totalBytes) * 100;
}

/**
 * Settings from the environment, made consistent: a threshold between 50 and 99,
 * a target at least 5 points under it, and a floor of at least one day.
 */
export function resolveDiskPressureSettings(raw: DiskPressureSettings): DiskPressureSettings {
  const thresholdPercent = Math.min(99, Math.max(50, Math.round(raw.thresholdPercent)));
  const maxTarget = thresholdPercent - 5;
  const targetPercent = Math.min(maxTarget, Math.max(10, Math.round(raw.targetPercent)));
  const minAgeDays = Math.max(1, Math.round(raw.minAgeDays));
  return { thresholdPercent, targetPercent, minAgeDays };
}

/**
 * One sweep. Returns null when the disk is under the threshold (or unreadable),
 * so a healthy server does nothing at all.
 */
export function runDiskPressureSweep(settings: DiskPressureSettings, deps: DiskPressureDeps): DiskPressureRun | null {
  const before = deps.readUsage();
  if (!before) return null;
  const percentBefore = usedPercent(before);
  if (percentBefore < settings.thresholdPercent) return null;

  const errors: string[] = [];
  let deletedFiles = 0;
  let freedBytes = 0;
  const absorb = (result: CleanupResult): void => {
    deletedFiles += result.deletedFiles;
    freedBytes += result.freedBytes;
    errors.push(...result.errors);
  };
  const currentPercent = (): number => {
    const usage = deps.readUsage();
    return usage ? usedPercent(usage) : percentBefore;
  };

  absorb(deps.cleanupSafe());
  absorb(deps.cleanupStaleTus());

  let stage: DiskPressureRun['stage'] = 'safe';
  if (currentPercent() >= settings.thresholdPercent) {
    stage = 'media';
    absorb(deps.evictOldest(settings.minAgeDays, () => currentPercent() < settings.targetPercent));
  }

  return {
    at: deps.now(),
    usedPercentBefore: round1(percentBefore),
    usedPercentAfter: round1(currentPercent()),
    stage,
    deletedFiles,
    freedBytes,
    errors: errors.slice(0, 20),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ─── Settings ───────────────────────────────────────────────────────────────

/** How often the worker looks at the disk. A check on a healthy disk is one `statfs` call. */
export const DISK_CHECK_INTERVAL_MINUTES = 15;
/** First check after boot, off the startup path. */
const FIRST_CHECK_DELAY_MS = 30_000;

export interface DiskCleanupSettings extends DiskPressureSettings {
  enabled: boolean;
}

/** The owner's settings, made consistent (`resolveDiskPressureSettings`). Off when the row is missing. */
export function readDiskCleanupSettings(): DiskCleanupSettings {
  const row = getDb().select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
  const resolved = resolveDiskPressureSettings({
    thresholdPercent: row?.diskCleanupThresholdPercent ?? 90,
    targetPercent: row?.diskCleanupTargetPercent ?? 80,
    minAgeDays: row?.diskCleanupMinAgeDays ?? 30,
  });
  return { enabled: row?.diskCleanupEnabled === 1, ...resolved };
}

// ─── Worker ─────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let firstCheck: ReturnType<typeof setTimeout> | null = null;
let lastRun: DiskPressureRun | null = null;
let sweeping = false;

function dataDir(): string {
  return dirname(config.dbPath);
}

function liveDeps(): DiskPressureDeps {
  return {
    readUsage: () => readDiskUsage(dataDir()),
    cleanupSafe: () => cleanupStorage(false),
    cleanupStaleTus: () => {
      const result = cleanupStaleTusSessions(60 * 60 * 1000, false);
      return {
        dryRun: false,
        deletedFiles: result.deletedFiles,
        freedBytes: result.freedBytes,
        deletedAttachmentRecords: 0,
        errors: result.errors,
      };
    },
    evictOldest: deleteOldestMedia,
    now: () => Date.now(),
  };
}

/**
 * Run one sweep with the owner's current settings. Does nothing while the
 * feature is off, and a sweep already running is not doubled. Returns the sweep
 * when the disk was over the threshold and one ran.
 */
export function sweepDiskPressure(): DiskPressureRun | null {
  if (sweeping) return null;
  sweeping = true;
  try {
    const settings = readDiskCleanupSettings();
    if (!settings.enabled) return null;
    const run = runDiskPressureSweep(settings, liveDeps());
    if (run) {
      lastRun = run;
      console.log(
        `[disk-cleanup] ${run.usedPercentBefore}% -> ${run.usedPercentAfter}% (${run.stage}): ` +
        `${run.deletedFiles} file(s), ${run.freedBytes} bytes freed${run.errors.length ? `, ${run.errors.length} error(s)` : ''}`,
      );
    }
    return run;
  } catch (err) {
    console.error(`[disk-cleanup] sweep failed: ${(err as Error).message}`);
    return null;
  } finally {
    sweeping = false;
  }
}

/** Starts the periodic check. It always runs; each tick reads the owner's switch, so turning it on takes effect without a restart. */
export function startDiskPressureWorker(): void {
  if (timer) return;
  timer = setInterval(sweepDiskPressure, DISK_CHECK_INTERVAL_MINUTES * 60 * 1000);
  // Do not keep the event loop alive solely for cleanup.
  if (typeof timer.unref === 'function') timer.unref();
  firstCheck = setTimeout(sweepDiskPressure, FIRST_CHECK_DELAY_MS);
  if (typeof firstCheck.unref === 'function') firstCheck.unref();
  console.log(`[disk-cleanup] worker started (checks every ${DISK_CHECK_INTERVAL_MINUTES} min; off until the owner enables it in Settings > Storage)`);
}

export function stopDiskPressureWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (firstCheck) {
    clearTimeout(firstCheck);
    firstCheck = null;
  }
}

export function getDiskPressureStatus(): DiskPressureStatus {
  const settings = readDiskCleanupSettings();
  const usage = readDiskUsage(dataDir());
  return {
    enabled: settings.enabled,
    usedPercent: usage ? round1(usedPercent(usage)) : null,
    totalBytes: usage ? usage.totalBytes : null,
    usedBytes: usage ? usage.usedBytes : null,
    thresholdPercent: settings.thresholdPercent,
    targetPercent: settings.targetPercent,
    minAgeDays: settings.minAgeDays,
    checkIntervalMinutes: DISK_CHECK_INTERVAL_MINUTES,
    lastRun,
  };
}
