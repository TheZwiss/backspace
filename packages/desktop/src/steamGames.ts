import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Local Steam game source.
 *
 * Resolves any installed Steam title — native or Proton — from the local
 * library metadata, no dictionary needed:
 *   <root>/steamapps/libraryfolders.vdf  → every library (any disk)
 *   <lib>/steamapps/appmanifest_*.acf    → appid, name, installdir, StateFlags
 *   <lib>/steamapps/common/<installdir>/ → install directory a running
 *                                          process' exe path must live under
 *
 * Proton and native games match identically: the /proc exe symlink of a
 * Proton-launched title resolves to the Windows .exe under
 * steamapps/common/<installdir>/ via Wine's Z: drive, so a plain path-prefix
 * check covers both. Prefixes under steamapps/compatdata are NOT install
 * directories and are not matched.
 */

export interface SteamGame {
  appId: number;
  name: string;
  /** Absolute path of <lib>/steamapps/common/<installdir> */
  installDir: string;
}

const INDEX_TTL_MS = 60_000;

let indexCache: { at: number; games: SteamGame[] } | null = null;

// ─── VDF / ACF parsing ──────────────────────────────────────────────────────

/**
 * Extract every library path from libraryfolders.vdf.
 * Each library block carries exactly one "path" key; values may contain
 * spaces and are returned unescaped.
 */
export function parseLibraryFoldersVdf(text: string): string[] {
  const libs: string[] = [];
  const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    if (raw !== undefined) libs.push(unescapeVdfString(raw));
  }
  return libs;
}

/** Read a single quoted value for a key from an ACF/manifest body. */
function acfValue(text: string, key: string): string | null {
  const keyIdx = text.indexOf(`"${key}"`);
  if (keyIdx === -1) return null;
  const rest = text.slice(keyIdx + key.length + 2);
  const m = rest.match(/^\s*"((?:[^"\\]|\\.)*)"/);
  const value = m?.[1];
  return value === undefined ? null : unescapeVdfString(value);
}

function unescapeVdfString(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

export interface ParsedAppManifest {
  appId: number;
  name: string;
  installdir: string;
  fullyInstalled: boolean;
}

/**
 * Parse an appmanifest_*.acf. Returns null when required fields are missing
 * or the app is not fully installed (StateFlags bit 4).
 */
export function parseAppManifest(text: string): ParsedAppManifest | null {
  const appId = Number(acfValue(text, 'appid'));
  const name = acfValue(text, 'name');
  const installdir = acfValue(text, 'installdir');
  const stateFlags = acfValue(text, 'StateFlags');

  if (!Number.isFinite(appId) || appId <= 0 || !name || !installdir || stateFlags === null) {
    return null;
  }

  const flags = Number(stateFlags);
  if (!Number.isFinite(flags)) return null;

  return {
    appId,
    name,
    installdir,
    // StateFlags is a bitmask; bit 4 (value 4) = FullyInstalled
    fullyInstalled: (flags & 4) !== 0,
  };
}

// ─── Root discovery ─────────────────────────────────────────────────────────

/**
 * Candidate Steam roots on Linux: the ~/.steam/steam symlink (deb/tar
 * installs), the native data dir, the Flatpak sandbox, and the snap layout.
 * Realpath-deduplicated so ~/.steam/steam and ~/.local/share/Steam collapse
 * into a single root, and nonexistent candidates are dropped.
 */
export function getSteamRoots(home: string = os.homedir()): string[] {
  const candidates = [
    path.join(home, '.steam', 'steam'),
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
  ];

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue; // Not installed from this packaging
    }
    if (!seen.has(real)) {
      seen.add(real);
      roots.push(real);
    }
  }
  return roots;
}

/** Library directories for a root: the vdf list, or the root itself. */
function libraryPathsForRoot(root: string): string[] {
  const vdfPath = path.join(root, 'steamapps', 'libraryfolders.vdf');
  let libs: string[] = [];
  try {
    libs = parseLibraryFoldersVdf(fs.readFileSync(vdfPath, 'utf-8'));
  } catch {
    // No vdf (very old install, partial copy) — the root is the only library
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const lib of [...libs, root]) {
    let real: string;
    try {
      real = fs.realpathSync(lib);
    } catch {
      continue; // Library on an unmounted disk
    }
    if (!seen.has(real)) {
      seen.add(real);
      resolved.push(real);
    }
  }
  return resolved;
}

/**
 * Steam installs its own plumbing as "apps" next to the games: the Linux
 * runtimes every Proton game runs inside, the Proton builds themselves, the
 * redistributables. They are in steamapps/common too, and their processes run
 * whenever any game (or just Steam) does, so indexing them makes the activity
 * "Steam Linux Runtime 3.0 (sniper)" instead of the game. The manifest carries
 * no "tool" flag, so they are told apart by their fixed names.
 */
const TOOL_NAMES = /^(steam linux runtime\b|proton\b|steamworks common redistributables\b)/i;
const TOOL_INSTALL_DIRS = /^(steamlinuxruntime|proton\b|steamworks shared$)/i;

export function isSteamToolApp(name: string, installdir: string): boolean {
  return TOOL_NAMES.test(name.trim()) || TOOL_INSTALL_DIRS.test(installdir.trim());
}

function readManifests(lib: string): SteamGame[] {
  const appsDir = path.join(lib, 'steamapps');
  let files: string[];
  try {
    files = fs.readdirSync(appsDir);
  } catch {
    return [];
  }

  const games: SteamGame[] = [];
  for (const file of files) {
    if (!file.startsWith('appmanifest_') || !file.endsWith('.acf')) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(appsDir, file), 'utf-8');
    } catch {
      continue;
    }
    const manifest = parseAppManifest(text);
    if (!manifest || !manifest.fullyInstalled) continue;
    if (isSteamToolApp(manifest.name, manifest.installdir)) continue;
    games.push({
      appId: manifest.appId,
      name: manifest.name,
      installDir: path.join(appsDir, 'common', manifest.installdir),
    });
  }
  return games;
}

/** Drop the index cache (test hook; also used after library changes). */
export function resetSteamIndexCache(): void {
  indexCache = null;
}

/**
 * All installed Steam games across every library of every root.
 * Cached for 60 seconds — a poll every 15s reuses the index instead of
 * re-reading manifests, while installs/uninstalls still show up within a
 * minute. Pass force=true to bypass.
 */
export function loadSteamIndex(roots: string[] = getSteamRoots(), force = false): SteamGame[] {
  if (!force && indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return indexCache.games;
  }

  const games: SteamGame[] = [];
  const seenAppIds = new Set<number>();
  for (const root of roots) {
    for (const lib of libraryPathsForRoot(root)) {
      for (const game of readManifests(lib)) {
        if (seenAppIds.has(game.appId)) continue; // Same library via two roots
        seenAppIds.add(game.appId);
        games.push(game);
      }
    }
  }

  indexCache = { at: Date.now(), games };
  return games;
}

// ─── Matching ───────────────────────────────────────────────────────────────

function isUnder(exe: string, dir: string): boolean {
  const e = exe.toLowerCase();
  const d = dir.toLowerCase();
  if (d.length > 0 && (e === d || e.startsWith(d.endsWith(path.sep) ? d : d + path.sep))) {
    return true;
  }
  try {
    const realExe = fs.realpathSync(exe).toLowerCase();
    const realDir = fs.realpathSync(dir).toLowerCase();
    return realDir.length > 0 && (realExe === realDir || realExe.startsWith(realDir.endsWith(path.sep) ? realDir : realDir + path.sep));
  } catch {
    return false;
  }
}

/**
 * The installed Steam game whose install directory contains the running
 * process' executable — native and Proton alike. Returns null when the exe
 * path is unavailable or belongs to no install directory.
 */
export function findSteamGameForProcess(exe: string | null, games: SteamGame[]): SteamGame | null {
  if (!exe) return null;
  for (const game of games) {
    if (isUnder(exe, game.installDir)) return game;
  }
  return null;
}

/** `SteamLaunch AppId=<id>` as Steam writes it on the command line of the `reaper` process that supervises a game. */
const STEAM_LAUNCH = /(?:^|\s)SteamLaunch\s+AppId=(\d+)(?=\s|$)/;

/**
 * The installed game Steam launched, read from the launch command of its
 * supervising `reaper` process. Every game Steam starts, native or Proton,
 * runs under one, and it names the app id outright: the game's own processes
 * (a wine binary inside the Proton directory) say nothing about it. Null when
 * the command line is no launch, or names an app that is not in `games`.
 */
export function findSteamGameForLaunch(cmdline: string, games: SteamGame[]): SteamGame | null {
  const match = STEAM_LAUNCH.exec(cmdline);
  if (!match) return null;
  const appId = Number(match[1]);
  return games.find((game) => game.appId === appId) ?? null;
}
