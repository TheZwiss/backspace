import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Each test gets a fresh tmp dir so file I/O stays isolated. The Proxy
// mock below reads `tmpDir` and `stragglerSweepMs` lazily on each access,
// so reassigning them in beforeEach (or per-test) takes effect immediately.
let tmpDir: string;
let stragglerSweepMs = 48 * 60 * 60 * 1000; // default 48h

vi.mock('../config.js', async () => {
  const real = await import('../config.js');
  return {
    config: new Proxy(real.config, {
      get(target, prop: string) {
        if (prop === 'tusUploadDir') return tmpDir;
        if (prop === 'tusStragglerSweepMs') return stragglerSweepMs;
        if (prop === 'tusExpirationMs') return 24 * 60 * 60 * 1000;
        return (target as Record<string, unknown>)[prop];
      },
    }),
  };
});

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `backspace-tus-jan-${crypto.randomBytes(8).toString('hex')}`);
  stragglerSweepMs = 48 * 60 * 60 * 1000;
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Note: cleanupTusUploads() is exercised indirectly through @tus/file-store's
// own test suite — full integration would require building a real FileStore
// state with creation_date sidecars, which adds little signal here.
describe('cleanupTusStragglers', () => {
  it('removes a file older than the sweep cutoff', async () => {
    const { cleanupTusStragglers } = await import('./storageJanitor.js');
    fs.mkdirSync(tmpDir, { recursive: true });
    const stale = path.join(tmpDir, 'stale-upload-id');
    fs.writeFileSync(stale, 'stale data');

    // Force mtime to 72h ago (stragglerSweepMs default is 48h)
    const seventyTwoHoursAgo = Date.now() - 72 * 60 * 60 * 1000;
    const seconds = seventyTwoHoursAgo / 1000;
    fs.utimesSync(stale, seconds, seconds);

    const result = cleanupTusStragglers();

    expect(result.removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('keeps a recent file', async () => {
    const { cleanupTusStragglers } = await import('./storageJanitor.js');
    fs.mkdirSync(tmpDir, { recursive: true });
    const fresh = path.join(tmpDir, 'fresh-upload-id');
    fs.writeFileSync(fresh, 'fresh data');
    // mtime defaults to "now" — well within the 48h window.

    const result = cleanupTusStragglers();

    expect(result.removed).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('returns { removed: 0 } when the directory does not exist', async () => {
    const { cleanupTusStragglers } = await import('./storageJanitor.js');
    // tmpDir was set in beforeEach but never created — so it doesn't exist.
    expect(fs.existsSync(tmpDir)).toBe(false);

    const result = cleanupTusStragglers();

    expect(result.removed).toBe(0);
  });

  it('honours an explicit threshold override', async () => {
    const { cleanupTusStragglers } = await import('./storageJanitor.js');
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, 'two-hour-old');
    fs.writeFileSync(file, 'data');
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const seconds = twoHoursAgo / 1000;
    fs.utimesSync(file, seconds, seconds);

    // Default 48h threshold would skip this file. Override to 1h to catch it.
    const result = cleanupTusStragglers(60 * 60 * 1000);

    expect(result.removed).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('getStaleTusInfo', () => {
  it('returns zeros when the directory does not exist', async () => {
    const { getStaleTusInfo } = await import('./storageJanitor.js');
    expect(fs.existsSync(tmpDir)).toBe(false);

    const info = getStaleTusInfo(60 * 60 * 1000);

    expect(info).toEqual({ count: 0, size: 0, oldestAt: null });
  });

  it('excludes entries newer than the threshold', async () => {
    const { getStaleTusInfo } = await import('./storageJanitor.js');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'fresh'), 'recent');
    // mtime defaults to "now" — within any reasonable threshold.

    const info = getStaleTusInfo(60 * 60 * 1000);

    expect(info.count).toBe(0);
    expect(info.size).toBe(0);
    expect(info.oldestAt).toBeNull();
  });

  it('includes entries older than the threshold and tracks oldest mtime', async () => {
    const { getStaleTusInfo } = await import('./storageJanitor.js');
    fs.mkdirSync(tmpDir, { recursive: true });

    const stale1 = path.join(tmpDir, 'stale-1');
    const stale2 = path.join(tmpDir, 'stale-2');
    const fresh = path.join(tmpDir, 'fresh');
    fs.writeFileSync(stale1, 'a'.repeat(100));
    fs.writeFileSync(stale2, 'b'.repeat(250));
    fs.writeFileSync(fresh, 'c'.repeat(50));

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    fs.utimesSync(stale1, twoHoursAgo / 1000, twoHoursAgo / 1000);
    fs.utimesSync(stale2, fourHoursAgo / 1000, fourHoursAgo / 1000);

    const info = getStaleTusInfo(60 * 60 * 1000); // 1h threshold

    expect(info.count).toBe(2);
    expect(info.size).toBe(350);
    expect(info.oldestAt).not.toBeNull();
    // Oldest mtime should be ~ fourHoursAgo (within fs precision, allow 1.5s slack)
    expect(Math.abs((info.oldestAt ?? 0) - fourHoursAgo)).toBeLessThan(1500);
  });

  it('skips subdirectories', async () => {
    const { getStaleTusInfo } = await import('./storageJanitor.js');
    fs.mkdirSync(tmpDir, { recursive: true });
    const sub = path.join(tmpDir, 'subdir');
    fs.mkdirSync(sub);
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    fs.utimesSync(sub, oneDayAgo / 1000, oneDayAgo / 1000);

    const info = getStaleTusInfo(60 * 60 * 1000);

    expect(info.count).toBe(0);
  });
});

describe('cleanupStaleTusSessions', () => {
  it('returns zero counts when the directory does not exist', async () => {
    const { cleanupStaleTusSessions } = await import('./storageJanitor.js');
    expect(fs.existsSync(tmpDir)).toBe(false);

    const result = cleanupStaleTusSessions(60 * 60 * 1000, false);

    expect(result.deletedFiles).toBe(0);
    expect(result.freedBytes).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('counts but does not delete when dryRun=true', async () => {
    const { cleanupStaleTusSessions } = await import('./storageJanitor.js');
    fs.mkdirSync(tmpDir, { recursive: true });
    const stale = path.join(tmpDir, 'stale');
    fs.writeFileSync(stale, 'x'.repeat(200));
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(stale, twoHoursAgo / 1000, twoHoursAgo / 1000);

    const result = cleanupStaleTusSessions(60 * 60 * 1000, true);

    expect(result.deletedFiles).toBe(1);
    expect(result.freedBytes).toBe(200);
    expect(result.errors).toEqual([]);
    // File must still exist on disk.
    expect(fs.existsSync(stale)).toBe(true);
  });

  it('unlinks stale entries when dryRun=false and leaves fresh ones alone', async () => {
    const { cleanupStaleTusSessions } = await import('./storageJanitor.js');
    fs.mkdirSync(tmpDir, { recursive: true });

    const stale = path.join(tmpDir, 'stale');
    const fresh = path.join(tmpDir, 'fresh');
    fs.writeFileSync(stale, 'x'.repeat(123));
    fs.writeFileSync(fresh, 'y'.repeat(456));

    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    fs.utimesSync(stale, threeHoursAgo / 1000, threeHoursAgo / 1000);

    const result = cleanupStaleTusSessions(60 * 60 * 1000, false);

    expect(result.deletedFiles).toBe(1);
    expect(result.freedBytes).toBe(123);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
