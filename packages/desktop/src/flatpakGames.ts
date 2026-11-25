import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Local Flatpak game source.
 *
 * A Flatpak app's processes run from
 *   <install>/app/<app-id>/<arch>/<branch>/active/files/...
 * so matching a running exe against that prefix identifies the app. Whether
 * the app is a *game* comes from its exported .desktop file's Categories
 * line (Game), and launchers (Steam, Lutris, Bottles, Heroic, itch, Prism)
 * are excluded so they don't shadow the games they start.
 */

export interface FlatpakGame {
  appId: string;
  name: string;
  /** Absolute path of .../active/files — exe paths under it belong to the app */
  filesDir: string;
}

const INDEX_TTL_MS = 60_000;

let indexCache: { at: number; games: FlatpakGame[] } | null = null;

/** Launcher app-ids (matched case-insensitively as substrings of the id). */
const LAUNCHER_ID_MARKERS = [
  'steam',
  'lutris',
  'bottles',
  'heroic',
  'itch',
  'prism',
];

/** Parse a Categories= line into category tokens. */
export function parseDesktopCategories(line: string): string[] {
  return line
    .split('=')
    .slice(1)
    .join('=')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Extract the display Name from .desktop content: the first bare `Name=`
 * wins over localized `Name[lang]=` entries, matching desktop-file semantics.
 */
export function parseDesktopName(content: string): string | null {
  for (const line of content.split('\n')) {
    const m = line.match(/^Name=(.*)$/);
    if (m && m[1] !== undefined && m[1].trim()) return m[1].trim();
  }
  return null;
}

/** Parse the Categories value from .desktop content (first match wins). */
export function desktopHasGameCategory(content: string): boolean {
  for (const line of content.split('\n')) {
    if (/^Categories=/.test(line)) {
      return parseDesktopCategories(line).some((c) => c.toLowerCase() === 'game');
    }
  }
  return false;
}

export function isLauncherAppId(appId: string): boolean {
  const lower = appId.toLowerCase();
  return LAUNCHER_ID_MARKERS.some((marker) => lower.includes(marker));
}

/** System-wide Flatpak installation dirs (parameterized so tests stay host-independent). */
const SYSTEM_INSTALL_DIRS = ['/var/lib/flatpak'];

/** Flatpak installation dirs: the user dir first, then the system ones. */
export function getFlatpakInstallDirs(
  home: string = os.homedir(),
  systemDirs: string[] = SYSTEM_INSTALL_DIRS,
): string[] {
  return [path.join(home, '.local', 'share', 'flatpak'), ...systemDirs].filter((dir) => {
    try {
      fs.accessSync(dir);
      return true;
    } catch {
      return false;
    }
  });
}

/** The .../active/files dir for an app, across whatever arch/branch exist. */
function findFilesDir(appDir: string): string | null {
  let arches: string[];
  try {
    arches = fs.readdirSync(appDir);
  } catch {
    return null;
  }
  for (const arch of arches) {
    let branches: string[];
    try {
      branches = fs.readdirSync(path.join(appDir, arch));
    } catch {
      continue;
    }
    for (const branch of branches) {
      const filesDir = path.join(appDir, arch, branch, 'active', 'files');
      try {
        fs.accessSync(filesDir);
        return fs.realpathSync(filesDir);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function readGamesFromInstall(installDir: string): FlatpakGame[] {
  const appsDir = path.join(installDir, 'app');
  const exportsDir = path.join(installDir, 'exports', 'share', 'applications');

  let appIds: string[];
  try {
    appIds = fs.readdirSync(appsDir);
  } catch {
    return [];
  }

  const games: FlatpakGame[] = [];
  for (const appId of appIds) {
    if (isLauncherAppId(appId)) continue;

    // Game classification comes from the exported .desktop file
    const desktopPath = path.join(exportsDir, `${appId}.desktop`);
    let content: string;
    try {
      content = fs.readFileSync(desktopPath, 'utf-8');
    } catch {
      continue; // Not exported / not a GUI app
    }
    if (!desktopHasGameCategory(content)) continue;

    const name = parseDesktopName(content);
    if (!name) continue;

    const filesDir = findFilesDir(path.join(appsDir, appId));
    if (!filesDir) continue;

    games.push({ appId, name, filesDir });
  }
  return games;
}

/** Drop the index cache (test hook). */
export function resetFlatpakIndexCache(): void {
  indexCache = null;
}

/**
 * All installed Flatpak games (Game category, launchers excluded), cached
 * for 60 seconds. force=true bypasses the cache.
 */
export function loadFlatpakIndex(installDirs: string[] = getFlatpakInstallDirs(), force = false): FlatpakGame[] {
  if (!force && indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return indexCache.games;
  }

  const games: FlatpakGame[] = [];
  const seen = new Set<string>();
  for (const installDir of installDirs) {
    for (const game of readGamesFromInstall(installDir)) {
      if (seen.has(game.appId)) continue;
      seen.add(game.appId);
      games.push(game);
    }
  }

  indexCache = { at: Date.now(), games };
  return games;
}

/** The Flatpak game whose sandbox files dir contains the running exe. */
export function findFlatpakGameForProcess(exe: string | null, games: FlatpakGame[]): FlatpakGame | null {
  if (!exe) return null;
  const lower = exe.toLowerCase();
  for (const game of games) {
    const dir = game.filesDir.toLowerCase();
    if (lower === dir || lower.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)) return game;
    try {
      const realExe = fs.realpathSync(exe).toLowerCase();
      const realDir = fs.realpathSync(game.filesDir).toLowerCase();
      if (realExe === realDir || realExe.startsWith(realDir.endsWith(path.sep) ? realDir : realDir + path.sep)) return game;
    } catch {
      // ignore
    }
  }
  return null;
}
