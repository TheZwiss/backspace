import { describe, it, expect, vi } from 'vitest';
import type { CleanupResult } from '@backspace/shared';
import {
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
