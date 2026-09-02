import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One vendored package's entry in `vendor.json`: the exact upstream version,
 * the exact URL it was fetched from, its license, and a map of committed
 * file path (relative to the repo root) to the sha256 of that file's bytes
 * as committed, prefixed `sha256-`.
 */
interface VendorEntry {
  version: string;
  source: string;
  license: string;
  files: Record<string, string>;
}

type VendorManifest = Record<string, VendorEntry>;

/**
 * Resolved from this file's own location rather than `process.cwd()`.
 * Vitest's working directory depends on how it was invoked (repo root,
 * `scripts/metrics/`, etc.), so a cwd-relative path here would make this
 * test pass or fail depending on invocation site. `import.meta.url` always
 * points at this file on disk regardless of cwd, so paths built from it are
 * stable.
 */
const srcDir = path.dirname(fileURLToPath(import.meta.url));
/** `scripts/metrics/` — one level up from `src/`, where `vendor.json` lives. */
const packageRoot = path.resolve(srcDir, '..');
/** Repo root — two levels up from `scripts/metrics/`. */
const repoRoot = path.resolve(packageRoot, '..', '..');

function loadManifest(): VendorManifest {
  const raw = readFileSync(path.join(packageRoot, 'vendor.json'), 'utf8');
  return JSON.parse(raw) as VendorManifest;
}

function sha256Hex(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

describe('vendor.json checksum manifest', () => {
  const manifest = loadManifest();
  const packageEntries = Object.entries(manifest);

  it('lists at least one vendored package', () => {
    expect(packageEntries.length).toBeGreaterThan(0);
  });

  for (const [packageName, entry] of packageEntries) {
    const fileEntries = Object.entries(entry.files);

    it(`${packageName}: manifest declares at least one file`, () => {
      expect(fileEntries.length).toBeGreaterThan(0);
    });

    for (const [relativeFile, recordedDigest] of fileEntries) {
      const absoluteFile = path.join(repoRoot, relativeFile);

      it(`${packageName}: ${relativeFile} exists on disk`, () => {
        expect(
          existsSync(absoluteFile),
          `vendor.json (package "${packageName}") lists "${relativeFile}" but no file exists ` +
            `at ${absoluteFile}. A manifest entry must point at a real, committed file.`,
        ).toBe(true);
      });

      it(`${packageName}: ${relativeFile} matches its recorded sha256`, () => {
        if (!existsSync(absoluteFile)) {
          // Covered by the existence assertion above; fail loudly here too
          // rather than letting a missing file read as a vacuous pass.
          throw new Error(
            `Cannot verify checksum for "${relativeFile}" (package "${packageName}"): ` +
              `no such file at ${absoluteFile}.`,
          );
        }

        const prefix = 'sha256-';
        expect(
          recordedDigest.startsWith(prefix),
          `vendor.json entry for "${relativeFile}" (package "${packageName}") must be a ` +
            `"sha256-<hex>" digest, got "${recordedDigest}".`,
        ).toBe(true);

        const expectedHex = recordedDigest.slice(prefix.length);
        const actualHex = sha256Hex(absoluteFile);

        expect(
          actualHex,
          `Checksum mismatch for "${relativeFile}" (package "${packageName}"): ` +
            `vendor.json records sha256 "${expectedHex}" but the committed file hashes to ` +
            `"${actualHex}". If this file was edited in place, that edit is not allowed — ` +
            `re-fetch the pinned upstream release named in vendor.json and, if the version was ` +
            `deliberately bumped, update the recorded hash to match.`,
        ).toBe(expectedHex);
      });
    }
  }
});
