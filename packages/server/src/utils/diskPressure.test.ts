import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import type { CleanupResult } from '@backspace/shared';
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

import {
  readDiskCleanupSettings,
  getDiskPressureStatus,
  sweepDiskPressure,
  resolveDiskPressureSettings,
  runDiskPressureSweep,
  usedPercent,
  type DiskPressureDeps,
  type DiskUsage,
} from './diskPressure.js';

const GB = 1024 ** 3;
const SETTINGS = { thresholdPercent: 90, targetPercent: 80, minAgeDays: 30 };

function usage(percent: number): DiskUsage {
  return { totalBytes: 100 * GB, usedBytes: percent * GB };
}

function result(deletedFiles: number, freedBytes: number, errors: string[] = []): CleanupResult {
  return { dryRun: false, deletedFiles, freedBytes, deletedAttachmentRecords: 0, errors };
}

/** A fake disk: each call that "frees" space lowers the percentage the next read returns. */
function harness(startPercent: number, freedBySafe = 0, freedPerMedia = 0) {
  let percent = startPercent;
  const deps = {
    readUsage: vi.fn((): DiskUsage | null => usage(percent)),
    cleanupSafe: vi.fn(() => { percent -= freedBySafe; return result(freedBySafe > 0 ? 3 : 0, freedBySafe * GB); }),
    cleanupStaleTus: vi.fn(() => result(0, 0)),
    evictOldest: vi.fn((_minAge: number, shouldStop: () => boolean) => {
      let deleted = 0;
      // Nothing old enough to delete: the sweep gives up without touching anything
      while (freedPerMedia > 0 && !shouldStop() && deleted < 1000) {
        percent -= freedPerMedia;
        deleted++;
      }
      return result(deleted, deleted * freedPerMedia * GB);
    }),
    now: () => 1_700_000_000_000,
  } satisfies DiskPressureDeps;
  return { deps, percent: () => percent };
}

describe('usedPercent', () => {
  it('is used over used plus available', () => {
    expect(usedPercent({ totalBytes: 200, usedBytes: 50 })).toBe(25);
  });
});

describe('resolveDiskPressureSettings', () => {
  it('keeps sane values as they are', () => {
    expect(resolveDiskPressureSettings(SETTINGS)).toEqual(SETTINGS);
  });

  it('clamps the threshold to 50..99', () => {
    expect(resolveDiskPressureSettings({ ...SETTINGS, thresholdPercent: 120 }).thresholdPercent).toBe(99);
    expect(resolveDiskPressureSettings({ ...SETTINGS, thresholdPercent: 10, targetPercent: 5 }).thresholdPercent).toBe(50);
  });

  it('keeps the target at least 5 points under the threshold', () => {
    expect(resolveDiskPressureSettings({ ...SETTINGS, targetPercent: 95 }).targetPercent).toBe(85);
    expect(resolveDiskPressureSettings({ ...SETTINGS, targetPercent: 90 }).targetPercent).toBe(85);
  });

  it('never allows a floor under one day', () => {
    expect(resolveDiskPressureSettings({ ...SETTINGS, minAgeDays: 0 }).minAgeDays).toBe(1);
    expect(resolveDiskPressureSettings({ ...SETTINGS, minAgeDays: -3 }).minAgeDays).toBe(1);
  });
});

describe('runDiskPressureSweep', () => {
  it('does nothing while the disk is under the threshold', () => {
    const h = harness(89.9);
    expect(runDiskPressureSweep(SETTINGS, h.deps)).toBeNull();
    expect(h.deps.cleanupSafe).not.toHaveBeenCalled();
    expect(h.deps.evictOldest).not.toHaveBeenCalled();
  });

  it('does nothing when the filesystem cannot be read', () => {
    const h = harness(95);
    h.deps.readUsage.mockReturnValue(null);
    expect(runDiskPressureSweep(SETTINGS, h.deps)).toBeNull();
    expect(h.deps.cleanupSafe).not.toHaveBeenCalled();
  });

  it('stops after the safe cleanups when they bring the disk under the threshold', () => {
    const h = harness(92, 5);
    const run = runDiskPressureSweep(SETTINGS, h.deps);
    expect(run).toMatchObject({ stage: 'safe', usedPercentBefore: 92, usedPercentAfter: 87 });
    expect(h.deps.evictOldest).not.toHaveBeenCalled();
  });

  it('deletes old chat media only when the safe cleanups were not enough, down to the target', () => {
    const h = harness(95, 1, 2);
    const run = runDiskPressureSweep(SETTINGS, h.deps);
    expect(h.deps.evictOldest).toHaveBeenCalledTimes(1);
    expect(h.deps.evictOldest.mock.calls[0]![0]).toBe(30);
    expect(run?.stage).toBe('media');
    expect(run!.usedPercentAfter).toBeLessThan(80);
    expect(run!.usedPercentAfter).toBeGreaterThan(75);
  });

  it('sums every stage into the run and keeps the errors', () => {
    const h = harness(95, 0, 0);
    h.deps.cleanupSafe.mockReturnValue(result(2, 4 * GB, ['safe failed']));
    h.deps.cleanupStaleTus.mockReturnValue(result(1, 1 * GB));
    h.deps.evictOldest.mockReturnValue(result(5, 10 * GB, ['media failed']));
    const run = runDiskPressureSweep(SETTINGS, h.deps)!;
    expect(run.deletedFiles).toBe(8);
    expect(run.freedBytes).toBe(15 * GB);
    expect(run.errors).toEqual(['safe failed', 'media failed']);
    expect(run.at).toBe(1_700_000_000_000);
  });

  it('gives up cleanly when nothing old enough is left to delete', () => {
    const h = harness(97, 0, 0);
    const run = runDiskPressureSweep(SETTINGS, h.deps)!;
    expect(run.stage).toBe('media');
    expect(run.deletedFiles).toBe(0);
    expect(run.usedPercentAfter).toBe(97);
  });
});

function freshDb(): void {
  sqlite = new Database(':memory:');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) sqlite.exec(stmt.trim());
    }
  }
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.instanceSettings).values({ id: 1, updatedAt: Date.now() }).run();
}

describe('settings stored by the instance owner', () => {
  beforeEach(freshDb);

  it('is off with 90 / 80 / 30 until the owner changes it', () => {
    expect(readDiskCleanupSettings()).toEqual({ enabled: false, thresholdPercent: 90, targetPercent: 80, minAgeDays: 30 });
  });

  it('reads what the owner saved', () => {
    sqlite.prepare('UPDATE instance_settings SET disk_cleanup_enabled = 1, disk_cleanup_threshold_percent = 85, disk_cleanup_target_percent = 70, disk_cleanup_min_age_days = 14 WHERE id = 1').run();
    expect(readDiskCleanupSettings()).toEqual({ enabled: true, thresholdPercent: 85, targetPercent: 70, minAgeDays: 14 });
  });

  it('repairs an inconsistent row instead of trusting it', () => {
    sqlite.prepare('UPDATE instance_settings SET disk_cleanup_enabled = 1, disk_cleanup_threshold_percent = 80, disk_cleanup_target_percent = 79, disk_cleanup_min_age_days = 1 WHERE id = 1').run();
    expect(readDiskCleanupSettings()).toMatchObject({ thresholdPercent: 80, targetPercent: 75 });
  });

  it('reports the settings and live usage in the status', () => {
    const status = getDiskPressureStatus();
    expect(status).toMatchObject({ enabled: false, thresholdPercent: 90, targetPercent: 80, minAgeDays: 30, checkIntervalMinutes: 15, lastRun: null });
  });

  it('does nothing while the owner has it off, even on a full disk', () => {
    expect(sweepDiskPressure()).toBeNull();
  });
});
