import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Reclaims the electron-updater download cache on builds that can never install
 * what it holds.
 *
 * An ad-hoc signed macOS build downloads the full release archive and then fails
 * Squirrel's signature check, leaving the archive on disk forever. The observed
 * cost on a real machine was 228 MB (the zip is stored twice, once staged and
 * once as `update.zip`) for a file that cannot be applied. Every check re-runs
 * the cycle.
 *
 * Turning `autoDownload` off stops new copies accruing. This removes the ones
 * already stranded on existing installs.
 */

/**
 * Extracts `updaterCacheDirName` from the app-update.yml electron-builder ships
 * inside the packaged app.
 *
 * The name is read rather than reconstructed on purpose. electron-builder
 * derives it from the package name (`@backspace/desktop` becomes
 * `@backspacedesktop-updater`), and a reimplementation of that rule would be a
 * guess about which directory to delete. Reading the file electron-updater
 * itself reads means we either know the answer or do nothing.
 *
 * A hand-rolled reader rather than a YAML dependency: this is one flat scalar
 * key, and the project does not add dependencies for one regex.
 */
export function parseUpdaterCacheDirName(yml: string): string | null {
  for (const raw of yml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const match = /^updaterCacheDirName\s*:\s*(.+)$/.exec(line);
    if (!match) continue;
    let value = (match[1] ?? '').trim();
    // Strip a trailing inline comment on an unquoted scalar.
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    return value.trim() === '' ? null : value.trim();
  }
  return null;
}

/**
 * The base cache directory electron-updater uses, reproduced from its own
 * `getAppCacheDir()` so the two agree on every platform.
 */
export function getAppCacheDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches');
  }
  return process.env['XDG_CACHE_HOME'] || path.join(home, '.cache');
}

/**
 * Whether a directory name is safe to delete as an updater cache.
 *
 * This is the guard that makes the whole operation defensible. The name has to
 * come out of app-update.yml *and* look like an updater cache: no separators, no
 * traversal, and a mandatory `-updater` suffix. A malformed or hostile
 * app-update.yml therefore cannot point this at anything else.
 */
export function isSafeUpdaterCacheDirName(name: string): boolean {
  if (!/^[A-Za-z0-9@._-]+$/.test(name)) return false;
  if (name.includes('..')) return false;
  if (!name.endsWith('-updater')) return false;
  // "-updater" alone carries no app identity; refuse it.
  if (name === '-updater') return false;
  return true;
}

/**
 * Resolves the updater cache directory, or null when it cannot be determined
 * safely. `resourcesPath` is `process.resourcesPath` in a packaged app.
 * `cacheDirOverride` exists so the deletion path can be exercised inside a
 * temporary directory on every platform, rather than only where an environment
 * variable happens to redirect the real cache.
 */
export function resolveUpdaterCacheDir(
  resourcesPath: string,
  cacheDirOverride?: string,
): string | null {
  let yml: string;
  try {
    yml = fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf-8');
  } catch {
    // No app-update.yml means this is not a packaged build with a feed. Nothing
    // to clean, and nothing that would tell us where to clean it.
    return null;
  }
  const name = parseUpdaterCacheDirName(yml);
  if (name === null || !isSafeUpdaterCacheDirName(name)) return null;
  return path.join(cacheDirOverride ?? getAppCacheDir(), name);
}

/**
 * Deletes the updater cache if it exists. Returns the number of bytes freed,
 * which is what makes the log line worth reading.
 *
 * Every failure is swallowed. Reclaiming disk is a courtesy, and no part of the
 * app should fail to start because a cache directory was busy.
 */
export function purgeUpdaterCache(resourcesPath: string, cacheDirOverride?: string): number {
  const dir = resolveUpdaterCacheDir(resourcesPath, cacheDirOverride);
  if (dir === null) return 0;

  let freed = 0;
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return 0;
    freed = directorySize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    return 0;
  }

  if (freed > 0) {
    console.log(
      `[update] reclaimed ${(freed / 1_048_576).toFixed(0)} MB from the updater ` +
      'cache, which this build cannot install from',
    );
  }
  return freed;
}

function directorySize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directorySize(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    } catch {
      // A file that vanished mid-walk contributes nothing.
    }
  }
  return total;
}
