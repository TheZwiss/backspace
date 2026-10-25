import fs from 'fs';
import os from 'os';
import path from 'path';
import { findSteamGameForProcess, getSteamRoots, loadSteamIndex } from './steamGames';
import { findFlatpakGameForProcess, loadFlatpakIndex, getFlatpakInstallDirs } from './flatpakGames';
import { findGogGameForProcess, loadGogIndex } from './gogGames';
import { extractPeIcon } from './peIcon';
import { findLauncherGameForProcess, loadLauncherIndex } from './launcherGames';

/**
 * Local game icon extraction.
 *
 * An activity card shows an icon for the detected game. Icons come from the
 * player's own machine — the same places a Linux desktop gets them from —
 * and are uploaded to the user's own instance, which hosts them like any
 * other user content. No third-party art service is contacted: nothing that
 * runs here talks to the network at all.
 *
 * Sources, in order:
 *   - Steam: the client's library cache (`appcache/librarycache`), keyed by
 *     the app id the manifest already gave us
 *   - Flatpak: the app's exported hicolor icons
 *   - GOG: `support/icon.png` inside the install directory
 *   - Anything else: files next to the executable (an AppImage mount exposes
 *     `.DirIcon` at its root; two levels up from `<mount>/usr/bin/...` is
 *     the mount root), and the system's `.desktop` entries, resolving their
 *     `Icon=` through the hicolor theme directories
 */

/** A game icon ready for hand-off to the renderer: bytes plus a sniffed MIME. */
export interface GameIcon {
  bytes: Buffer;
  mime: string;
}

/** What the detector knows about the game it wants an icon for. */
export interface GameIconTarget {
  /** MatchedGame.id: `steam-<appid>`, `flatpak-<appid>`, `gog-<id>`, or a dictionary key */
  id: string;
  /** The display name the activity carries; keys the cache the renderer asks by. */
  name: string;
  /** Full executable path of the running game, when /proc exposed one. */
  exe: string | null;
  /** The process command line (may name the AppImage the binary was mounted from). */
  cmdline: string;
  /** Windows program names of a Wine process (`ZenlessZoneZero.exe`). */
  winExes?: string[];
  /** Working directory of that process: where the program's own .exe lies. */
  cwd?: string | null;
}

/**
 * Icons are small images; anything bigger is not read. Kept in sync with
 * MAX_GAME_ICON_BYTES in @backspace/shared, the most the server accepts: a
 * larger file would only travel to the renderer and come back refused.
 */
const MAX_ICON_BYTES = 512 * 1024;
/** A .desktop file larger than this is not a desktop entry. */
const MAX_DESKTOP_FILE_BYTES = 64 * 1024;
/** Bound the .desktop scan: a system has hundreds, not millions. */
const MAX_DESKTOP_FILES = 2000;
/** hicolor size directories, largest first: the biggest icon a theme offers wins. */
const HICOLOR_SIZE_DIRS = ['512x512', '384x384', '256x256', '192x192', '128x128', '96x96', '64x64', '48x48', '32x32', '24x24', '16x16'];
/** Icon-ish file names looked for next to (and above) a game executable. */
const EXE_DIR_ICON_NAMES = ['.DirIcon', 'icon.png', 'Icon.png', 'icon_256.png', 'logo.png', 'cover.png'];

/**
 * The image formats the whole pipeline accepts (the server re-encodes to
 * WebP). SVG and XPM are deliberately absent: browsers do not reliably render
 * the former and do not render the latter at all.
 */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

async function readIconFile(file: string): Promise<GameIcon | null> {
  let bytes: Buffer;
  try {
    // Look before reading: a candidate can be any file on the machine, and
    // only a regular file within the limit is ever read, into a buffer of
    // exactly its size (a symlink such as an AppImage's .DirIcon is followed).
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ICON_BYTES) return null;
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const mime = sniffImageMime(bytes);
  return mime ? { bytes, mime } : null;
}

async function firstExistingIcon(files: string[]): Promise<GameIcon | null> {
  for (const file of files) {
    const icon = await readIconFile(file);
    if (icon) return icon;
  }
  return null;
}

// ─── Steam ──────────────────────────────────────────────────────────────────

/** Steam's library cache, keyed by app id: the icon and cover art the client downloaded. */
async function steamIcon(appId: number, home: string): Promise<GameIcon | null> {
  for (const root of getSteamRoots(home)) {
    const cache = path.join(root, 'appcache', 'librarycache');
    const icon = await firstExistingIcon([
      path.join(cache, `${appId}_icon.jpg`),
      path.join(cache, `${appId}`, 'library_600x900.jpg'),
      path.join(cache, `${appId}`, 'header.jpg'),
      path.join(cache, `${appId}.jpg`),
    ]);
    if (icon) return icon;
  }
  return null;
}

// ─── Flatpak ────────────────────────────────────────────────────────────────

function flatpakIconCandidates(appId: string, installDirs: string[], home: string): string[] {
  const dirs = [
    ...installDirs,
    // The per-user install is not always in the default list above.
    path.join(home, '.local', 'share', 'flatpak'),
  ];
  const candidates: string[] = [];
  for (const dir of dirs) {
    const exported = path.join(dir, 'exports', 'share', 'icons', 'hicolor');
    for (const size of HICOLOR_SIZE_DIRS) {
      candidates.push(path.join(exported, size, 'apps', `${appId}.png`));
    }
  }
  return candidates;
}

async function flatpakIcon(appId: string, home: string): Promise<GameIcon | null> {
  // The app's own export first: it exists even for installs at custom paths.
  for (const game of loadFlatpakIndex()) {
    if (game.appId !== appId) continue;
    const appExport = path.resolve(game.filesDir, '..', '..', 'export', 'share', 'icons', 'hicolor');
    const own: string[] = [];
    for (const size of HICOLOR_SIZE_DIRS) {
      own.push(path.join(appExport, size, 'apps', `${appId}.png`));
    }
    const icon = await firstExistingIcon(own);
    if (icon) return icon;
  }
  return firstExistingIcon(flatpakIconCandidates(appId, getFlatpakInstallDirs(), home));
}

// ─── GOG ────────────────────────────────────────────────────────────────────

async function gogIcon(gameId: string, home: string): Promise<GameIcon | null> {
  for (const game of loadGogIndex(home)) {
    if (game.id !== gameId) continue;
    return firstExistingIcon([
      path.join(game.dir, 'support', 'icon.png'),
      path.join(game.dir, 'support', 'icon_256.png'),
      path.join(game.dir, 'support', 'icon_512.png'),
    ]);
  }
  return null;
}

// ─── Executable directory and .desktop resolution ───────────────────────────

/** Directory candidates: the exe's own dir and two levels up (an AppImage mounts at /tmp/.mount_x with the binary under usr/bin). */
function exeDirCandidates(exe: string): string[] {
  const dir = path.dirname(exe);
  return [dir, path.resolve(dir, '..'), path.resolve(dir, '..', '..')];
}

function exeSiblingIcons(exe: string): string[] {
  const base = path.basename(exe);
  const baseNoExt = base.replace(/\.[^.]+$/, '');
  const files: string[] = [];
  for (const dir of exeDirCandidates(exe)) {
    if (baseNoExt !== base) files.push(path.join(dir, `${baseNoExt}.png`));
    for (const name of EXE_DIR_ICON_NAMES) files.push(path.join(dir, name));
  }
  return files;
}

interface DesktopEntry {
  exec: string;
  name: string;
  icon: string;
}

/** Parse the fields an icon lookup needs out of a .desktop file body. */
export function parseDesktopEntry(text: string): DesktopEntry | null {
  let exec = '';
  let name = '';
  let icon = '';
  let inDesktopSection = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inDesktopSection = trimmed === '[Desktop Entry]';
      continue;
    }
    if (!inDesktopSection) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === 'Exec' && !exec) exec = value;
    else if (key === 'Name' && !name) name = value;
    else if (key === 'Icon' && !icon) icon = value;
  }
  if (!icon) return null;
  return { exec, name, icon };
}

/**
 * Programs that host or launch a game instead of being it. A game running on
 * one has the host's name as its executable, so a .desktop entry that merely
 * runs the same host (JDownloader on java) says nothing about the game.
 */
const HOST_PROGRAMS = /^(java|javaw|python[\d.]*|wine(64|-preloader|loader)?|mono|dotnet|node|nodejs|electron|ruby|perl|lua|luajit|love|sh|bash|dash|zsh|env|flatpak|bwrap|steam|reaper|proton|gamescope|gamemoderun|mangohud|ld-linux[\w.-]*|pressure-vessel[\w-]*|steam-runtime[\w-]*)$/i;

/** The program an Exec= line runs: `env` and its assignments skipped, quotes respected, directory dropped, lowercased. */
export function execProgramName(exec: string): string {
  const tokens = exec.match(/"[^"]*"|\S+/g) ?? [];
  for (const raw of tokens) {
    const token = raw.replace(/^"|"$/g, '');
    if (token === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return path.basename(token).toLowerCase();
  }
  return '';
}

function desktopDirectories(home: string): string[] {
  return [
    path.join(home, '.local', 'share', 'applications'),
    '/usr/share/applications',
    '/usr/local/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
  ];
}

/** All .desktop entries on the system, user directory first (user overrides win). */
function readDesktopEntries(home: string): DesktopEntry[] {
  const entries: DesktopEntry[] = [];
  for (const dir of desktopDirectories(home)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entryName of names) {
      if (!entryName.endsWith('.desktop')) continue;
      if (entries.length >= MAX_DESKTOP_FILES) return entries;
      const file = path.join(dir, entryName);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_DESKTOP_FILE_BYTES || stat.size === 0) continue;
        const parsed = parseDesktopEntry(fs.readFileSync(file, 'utf8'));
        if (parsed) entries.push(parsed);
      } catch {
        continue;
      }
    }
  }
  return entries;
}

/** Theme lookup for a bare `Icon=` name: hicolor sizes, then pixmaps, then flatpak exports. */
function themedIconCandidates(iconName: string, home: string): string[] {
  const candidates: string[] = [];
  const iconBases = iconName.endsWith('.png') ? [iconName, `${iconName}.png`] : [`${iconName}.png`];
  const themeRoots = [
    path.join('/usr', 'share', 'icons', 'hicolor'),
    path.join(home, '.local', 'share', 'icons', 'hicolor'),
    path.join('/var', 'lib', 'flatpak', 'exports', 'share', 'icons', 'hicolor'),
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'icons', 'hicolor'),
  ];
  for (const base of iconBases) {
    for (const root of themeRoots) {
      for (const size of HICOLOR_SIZE_DIRS) {
        candidates.push(path.join(root, size, 'apps', base));
      }
    }
    candidates.push(path.join('/usr', 'share', 'pixmaps', base));
  }
  return candidates;
}

/** The `Icon=` of a .desktop entry: an absolute path, or a theme name resolved through hicolor. */
function iconFromDesktopEntry(entry: DesktopEntry, home: string): string[] {
  if (entry.icon.startsWith('/')) return [entry.icon];
  return themedIconCandidates(entry.icon, home);
}

/**
 * Generic resolution for everything without a dedicated source: files next to
 * the executable first, then the system's .desktop entries whose Exec runs
 * the same program (never a host such as java or wine) or whose Name is the
 * game's display name.
 */
async function genericIcon(target: GameIconTarget, home: string): Promise<GameIcon | null> {
  const exeBase = target.exe ? path.basename(target.exe).toLowerCase() : '';
  if (target.exe) {
    const sibling = await firstExistingIcon(exeSiblingIcons(target.exe));
    if (sibling) return sibling;
  }
  const nameLower = target.name.trim().toLowerCase();
  for (const entry of readDesktopEntries(home)) {
    const execMatches = exeBase !== '' && !HOST_PROGRAMS.test(exeBase) && execProgramName(entry.exec) === exeBase;
    const nameMatches = nameLower !== '' && entry.name.trim().toLowerCase() === nameLower;
    if (!execMatches && !nameMatches) continue;
    const icon = await firstExistingIcon(iconFromDesktopEntry(entry, home));
    if (icon) return icon;
  }
  return null;
}

const STORE_ID = /^(steam|flatpak|gog|heroic|bottles|lutris)-/;

/**
 * The store id (`steam-<appid>`, `flatpak-<id>`, `gog-<id>`) of an installed
 * game, for a target whose own id says nothing about a store: a game the
 * dictionary matched, or one the player named by hand. First by the running
 * executable, which is exact, then by the display name equal to the name the
 * store's manifest gives, ignoring case. Null when no store knows the game.
 */
function installedGameId(target: GameIconTarget, home: string): string | null {
  if (STORE_ID.test(target.id)) return null;
  const steam = loadSteamIndex(getSteamRoots(home), true);
  const flatpak = loadFlatpakIndex(getFlatpakInstallDirs(home), true);
  const gog = loadGogIndex(home, true);

  if (target.exe) {
    const bySteam = findSteamGameForProcess(target.exe, steam);
    if (bySteam) return `steam-${bySteam.appId}`;
    const byFlatpak = findFlatpakGameForProcess(target.exe, flatpak);
    if (byFlatpak) return `flatpak-${byFlatpak.appId}`;
    const byGog = findGogGameForProcess(target.exe, target.cmdline, gog);
    if (byGog) return `gog-${byGog.id}`;
  }
  const launcher = loadLauncherIndex(home, true);
  const byLauncher = findLauncherGameForProcess(
    { exe: target.exe, cmdline: target.cmdline, winExes: target.winExes, cwd: target.cwd ?? undefined },
    launcher,
  );
  if (byLauncher) return byLauncher.id;

  const name = target.name.trim().toLowerCase();
  if (name === '') return null;
  const sameName = (candidate: string) => candidate.trim().toLowerCase() === name;
  const bySteamName = steam.find((game) => sameName(game.name));
  if (bySteamName) return `steam-${bySteamName.appId}`;
  const byFlatpakName = flatpak.find((game) => sameName(game.name));
  if (byFlatpakName) return `flatpak-${byFlatpakName.appId}`;
  const byGogName = gog.find((game) => sameName(game.name));
  if (byGogName) return `gog-${byGogName.id}`;
  const byLauncherName = launcher.find((game) => sameName(game.name));
  if (byLauncherName) return byLauncherName.id;
  return null;
}

/**
 * A game run under Wine has no icon file of its own, but its .exe carries one
 * in its resources. The program is looked up in the process's working
 * directory (exact name first, then ignoring case: Windows paths do not care).
 */
async function windowsProgramIcon(target: GameIconTarget): Promise<GameIcon | null> {
  if (!target.cwd || !target.winExes) return null;
  let entries: string[] | null = null;
  for (const name of target.winExes) {
    if (!/\.exe$/i.test(name) || name.includes('/') || name.includes('\\')) continue;
    let file: string | null = path.join(target.cwd, name);
    if (!isFile(file)) {
      entries ??= safeReaddir(target.cwd);
      const found = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
      file = found ? path.join(target.cwd, found) : null;
    }
    if (!file) continue;
    const bytes = await extractPeIcon(file, MAX_ICON_BYTES);
    if (bytes) return { bytes, mime: 'image/png' };
  }
  return null;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Find an icon for a detected game. Sources are tried in order of precision;
 * the first readable image file wins. Every miss is cheap (a stat), every hit
 * is a bounded read.
 */
export async function findGameIcon(
  target: GameIconTarget,
  home: string = os.homedir(),
): Promise<GameIcon | null> {
  // A dictionary match or a hand-typed name still belongs to a store when the
  // machine has the game installed through one
  const id = installedGameId(target, home) ?? target.id;
  if (id.startsWith('steam-')) {
    const appId = Number(id.slice('steam-'.length));
    if (Number.isInteger(appId) && appId > 0) {
      const icon = await steamIcon(appId, home);
      if (icon) return icon;
    }
  }
  if (id.startsWith('flatpak-')) {
    const appId = id.slice('flatpak-'.length);
    if (appId) {
      const icon = await flatpakIcon(appId, home);
      if (icon) return icon;
    }
  }
  if (id.startsWith('gog-')) {
    const gameId = id.slice('gog-'.length);
    if (gameId) {
      const icon = await gogIcon(gameId, home);
      if (icon) return icon;
    }
  }
  if (id.startsWith('lutris-') || id.startsWith('bottles-')) {
    const game = loadLauncherIndex(home).find((candidate) => candidate.id === id);
    if (game?.iconPath) {
      const icon = await firstExistingIcon([game.iconPath]);
      if (icon) return icon;
    }
  }
  const fromExe = await windowsProgramIcon(target);
  if (fromExe) return fromExe;
  return genericIcon(target, home);
}

// ─── Cache ──────────────────────────────────────────────────────────────────

/** game name → resolved icon; a null value is a remembered miss. */
const iconCache = new Map<string, GameIcon | null>();
/** game name → in-flight warm-up, so repeated polls never pile up reads and a second asker waits for the first. */
const iconWarming = new Map<string, Promise<void>>();

/**
 * Resolve and cache the icon for a game the detector just matched. The
 * returned promise settles when the cache entry is written; production
 * callers fire and forget — the activity is emitted without waiting, and
 * the renderer picks the icon up through the `get-game-icon` IPC when the
 * next push asks for it.
 */
export function warmGameIcon(target: GameIconTarget, home: string = os.homedir()): Promise<void> {
  if (!target.name || iconCache.has(target.name)) return Promise.resolve();
  const pending = iconWarming.get(target.name);
  if (pending) return pending;
  const warming = findGameIcon(target, home)
    .then((icon) => {
      iconCache.set(target.name, icon);
      console.log(
        icon
          ? `[ActivityDetector] Game icon resolved for "${target.name}" (${icon.bytes.length} bytes, ${icon.mime})`
          : `[ActivityDetector] No game icon found for "${target.name}"`,
      );
    })
    .catch(() => {
      iconCache.set(target.name, null);
    })
    .finally(() => {
      iconWarming.delete(target.name);
    });
  iconWarming.set(target.name, warming);
  return warming;
}

/**
 * Resolve the icon for an IPC-pushed activity: the pushing process's own
 * executable is the best lead (an AppImage mount keeps `.DirIcon` at its
 * root, two levels above the mounted binary).
 */
export function warmGameIconForIpc(name: string, pid: number | null, procRoot = '/proc'): Promise<void> {
  if (!name || iconCache.has(name) || iconWarming.has(name)) return Promise.resolve();
  let exe: string | null = null;
  if (pid !== null && pid > 0) {
    try {
      exe = fs.readlinkSync(path.join(procRoot, String(pid), 'exe'));
    } catch {
      exe = null;
    }
  }
  return warmGameIcon({ id: '', name, exe, cmdline: '' });
}

/** The cached icon for a game name, if warming has finished. Null on miss or not-yet. */
export function getGameIcon(name: string): GameIcon | null {
  return iconCache.get(name) ?? null;
}

/**
 * The icon for a game name the renderer asks about, waiting for the lookup
 * when one is not finished (or never started: a game the player named by
 * hand was never detected, so nothing warmed it).
 */
export async function resolveGameIcon(name: string): Promise<GameIcon | null> {
  await warmGameIcon({ id: '', name, exe: null, cmdline: '' });
  return getGameIcon(name);
}

/** Tests only: forget every cached icon. */
export function __testResetGameIconCache(): void {
  iconCache.clear();
  iconWarming.clear();
}
