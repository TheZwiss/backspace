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
});
