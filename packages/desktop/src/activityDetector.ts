import { execFile } from 'child_process';
import https from 'https';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';
import { findSteamGameForLaunch, findSteamGameForProcess, loadSteamIndex, type SteamGame } from './steamGames';
import { findFlatpakGameForProcess, loadFlatpakIndex } from './flatpakGames';
import { findGogGameForProcess, loadGogIndex } from './gogGames';
import { findLauncherGameForProcess, loadLauncherIndex } from './launcherGames';
import { warmGameIcon, warmGameIconForIpc } from './gameIcons';
import type { IpcActivityPush } from './richPresenceIpc';
import { decodeWin32Output } from './mediaDetector/win32Media';

// ─── Local Activity type (structural match with @backspace/shared Activity) ─

export interface ActivityTimestamps {
  start?: number;
  end?: number;
}

export interface ActivityPlayback {
  positionMs: number;
  durationMs?: number;
}

export interface Activity {
  type: string;
  name: string;
  details?: string;
  state?: string;
  timestamps?: ActivityTimestamps;
  playback?: ActivityPlayback;
  assets?: ActivityAssets;
}

interface ActivityAssets {
  largeImage?: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
}

// ─── Game dictionary types ──────────────────────────────────────────────────

interface GameEntry {
  id: string;
  name: string;
  /** Executable names matched against the process name (case-insensitive). */
  processes: string[];
  /**
   * Substrings matched against the process command line (case-insensitive).
   * Lets one entry cover every launcher variant of a game whose actual
   * process is a bare interpreter (Minecraft → `java`).
   */
  cmdlinePatterns?: string[];
  type?: string;
}

interface VersionedDictionary {
  version: number;
  games: GameEntry[];
}

const VALID_TYPES = new Set(['playing', 'listening', 'watching', 'streaming']);
const POLL_INTERVAL_MS = 15_000;
const REMOTE_URL = 'https://raw.githubusercontent.com/TheZwiss/backspace/main/packages/desktop/resources/games.json';

/**
 * The Linux kernel stores comm values in a 16-byte buffer including the NUL
 * terminator, so long executable names appear truncated to 15 characters in
 * /proc/<pid>/comm (and in `ps` output): "minecraft-launcher" → "minecraft-launc".
 */
const COMM_MAX = 15;

// ─── Module state ───────────────────────────────────────────────────────────

let gameEntries: GameEntry[] = [];
let dictionaryVersion = 0;
let scanActivities: Activity[] = [];
let ipcOverride: Activity | null = null;
let currentActivities: Activity[] = [];
let intervalId: NodeJS.Timeout | null = null;
let isPolling = false;
/** The programs the player says their games are (see `setManualBindings`). */
let manualBindings: ManualBinding[] = [];

let hasErrored = false;
let onChangeCallback: ((activity: Activity | null) => void) | null = null;
let onListChangeCallback: ((activities: Activity[]) => void) | null = null;

// ─── Process information ────────────────────────────────────────────────────

export interface ProcessInfo {
  pid: number;
  /** Best-effort process name: exe basename, else first cmdline token, else comm. */
  name: string;
  /** Command line tokens joined with single spaces (empty when unavailable). */
  cmdline: string;
  /** Full executable path from the /proc exe symlink, case preserved; null when unavailable. */
  exe: string | null;
  /**
   * The Windows programs a Wine/Proton process may be running ("StarRail.exe").
   * Its `exe` is the Wine loader, so `name` says "wine64-preloader" whatever
   * the game is; the real names are in the command line (a Windows path, or
   * "steam.exe Game.exe" as Proton's shim writes it) and, kernel-truncated, in
   * comm. Absent for anything that is not a Wine process.
   */
  winExes?: string[];
  /**
   * Working directory of a Wine process. The Windows program is usually
   * started from its own folder, which is where its icon is found. Only set
   * together with `winExes`.
   */
  cwd?: string;
}

/**
 * Pick the most descriptive process name from what /proc exposed:
 * exe symlink (preserves full length and case), first cmdline token, or comm
 * (may be kernel-truncated to COMM_MAX characters).
 */
export function pickProcName(exeLink: string | null, cmdlineTokens: string[], comm: string | null): string | null {
  if (exeLink) {
    const base = path.basename(exeLink);
    if (base) return base;
  }
  const first = cmdlineTokens[0];
  if (first) {
    // A Windows path ("Z:\\games\\Game.exe") has no "/" for basename to split on
    const base = WINDOWS_PATH.test(first) ? first.slice(first.search(/[^\\/]*$/)).replace(/"$/, '') : path.basename(first);
    if (base) return base;
  }
  return comm ?? null;
}

const WINDOWS_PATH = /^"?[A-Za-z]:[\\/]/;
/** Every "<name>.exe" in a command line, whatever separators precede it and whatever arguments follow. */
const EXE_NAMES = /([^\\/"]+?\.exe)(?=["\s]|$)/gi;
/**
 * Programs every Wine prefix runs whatever the game is, and a game's own
 * crash handlers: never a game, so never a candidate. Proton's `steam.exe`
 * shim is the exception that stays when nothing else is named (the real
 * Windows Steam client has a path in front of it, the shim is `steam.exe Game.exe`).
 */
const WINE_PLUMBING = [
  'start.exe', 'explorer.exe', 'services.exe', 'svchost.exe', 'winedevice.exe', 'plugplay.exe', 'rpcss.exe',
  'tabtip.exe', 'conhost.exe', 'wineboot.exe', 'winemenubuilder.exe', 'rundll32.exe', 'cmd.exe',
  'unitycrashhandler32.exe', 'unitycrashhandler64.exe', 'microsoftedgeupdate.exe',
];

/** Plumbing, by full name or by its kernel-truncated comm ("UnityCrashHandl"). */
function isWinePlumbing(name: string): boolean {
  const lower = name.toLowerCase();
  return WINE_PLUMBING.some((p) => p === lower || (lower.length === COMM_MAX && p.startsWith(lower)));
}

/**
 * The Windows programs a Wine process may be running, most specific first, or
 * undefined for any other process. A Wine process is recognised by its loader
 * (`wine`, `wine64-preloader`, Proton's and Bottles' builds of it) or by a
 * Windows-style command line; a native program that merely has "foo.exe" among
 * its arguments (an editor opening one) is not one.
 *
 * The command line is read as one string: a path with spaces ("C:\\GOG Games\\
 * Stardew Valley\\Stardew Valley.exe") may arrive as one argv token or several.
 */
export function deriveWindowsExes(exeLink: string | null, cmdlineTokens: string[], comm: string | null): string[] | undefined {
  const base = exeLink ? path.basename(exeLink) : '';
  const isLoader = /^wine(?!server)/i.test(base);
  const first = cmdlineTokens[0];
  const windowsStyle = first !== undefined && WINDOWS_PATH.test(first);
  if (!isLoader && !windowsStyle) return undefined;

  const names: string[] = [];
  const add = (name: string) => {
    const trimmed = name.trim();
    if (trimmed !== '' && !names.some((n) => n.toLowerCase() === trimmed.toLowerCase())) names.push(trimmed);
  };
  for (const match of cmdlineTokens.join(' ').matchAll(EXE_NAMES)) {
    const captured = (match[1] ?? '').trim();
    if (isWinePlumbing(captured)) continue;
    // Arguments before the first path separator ("-k Foo bar.exe") ride along in the capture
    const words = captured.split(' ');
    for (let from = 0; from < words.length; from++) add(words.slice(from).join(' '));
  }
  // Wine names the process after its program, cut to the kernel's 15 characters
  if (isLoader && comm && !/^wine/i.test(comm) && !isWinePlumbing(comm)) add(comm);

  // The shim names the game after itself; alone, it is the program
  const real = names.filter((n) => n.toLowerCase() !== 'steam.exe');
  const result = real.length > 0 ? real : names;
  return result.length > 0 ? result : undefined;
}

/**
 * Read the running process list on Linux by walking /proc directly.
 * No external command, no parsing race: for each numeric pid directory we
 * read the exe symlink (full executable name, wine paths included), the
 * NUL-separated cmdline, and comm as a last resort.
 *
 * `procRoot` is injectable so tests can fabricate a fake /proc tree.
 */
export function readProcessInfos(procRoot = '/proc'): ProcessInfo[] {
  const infos: ProcessInfo[] = [];
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot);
  } catch {
    return infos;
  }

  for (const pidStr of pids) {
    if (!/^\d+$/.test(pidStr)) continue;
    const dir = path.join(procRoot, pidStr);

    let exeLink: string | null = null;
    try {
      const target = fs.readlinkSync(path.join(dir, 'exe'));
      // The kernel appends " (deleted)" when the binary was replaced/exited
      if (target && !target.endsWith(' (deleted)')) exeLink = target;
    } catch {
      // EACCES for other users' processes, ENOENT for kernel threads — fall through
    }

    let cmdlineTokens: string[] = [];
    try {
      const raw = fs.readFileSync(path.join(dir, 'cmdline'));
      cmdlineTokens = raw.toString('utf-8').split('\0').filter((t) => t.length > 0);
    } catch {
      // Process exited between readdir and read — skip its cmdline
    }

    let comm: string | null = null;
    try {
      comm = fs.readFileSync(path.join(dir, 'comm'), 'utf-8').trim() || null;
    } catch {
      // Same race as above
    }

    const name = pickProcName(exeLink, cmdlineTokens, comm);
    if (!name) continue; // kernel thread: no exe, no cmdline

    const info: ProcessInfo = { pid: Number(pidStr), name, cmdline: cmdlineTokens.join(' '), exe: exeLink };
    const winExes = deriveWindowsExes(exeLink, cmdlineTokens, comm);
    if (winExes) {
      info.winExes = winExes;
      const cwd = readCwd(dir);
      if (cwd) info.cwd = cwd;
    }
    infos.push(info);
  }

  return infos;
}

/** Read a single process' info by pid from /proc (used for late name lookups). */
function readCwd(procDir: string): string | null {
  try {
    const target = fs.readlinkSync(path.join(procDir, 'cwd'));
    return target && !target.endsWith(' (deleted)') ? target : null;
  } catch {
    return null; // gone, or not ours to read
  }
}

export function readProcessInfoByPid(pid: number, procRoot = '/proc'): ProcessInfo | null {
  const dir = path.join(procRoot, String(pid));
  try {
    fs.accessSync(dir);
  } catch {
    return null;
  }

  let exeLink: string | null = null;
  try {
    const target = fs.readlinkSync(path.join(dir, 'exe'));
    if (target && !target.endsWith(' (deleted)')) exeLink = target;
  } catch {
    // Unreadable exe — fall through
  }

  let cmdlineTokens: string[] = [];
  try {
    cmdlineTokens = fs.readFileSync(path.join(dir, 'cmdline')).toString('utf-8').split('\0').filter((t) => t.length > 0);
  } catch {
    // Unreadable cmdline
  }

  let comm: string | null = null;
  try {
    comm = fs.readFileSync(path.join(dir, 'comm'), 'utf-8').trim() || null;
  } catch {
    // Unreadable comm
  }

  const name = pickProcName(exeLink, cmdlineTokens, comm);
  if (!name) return null;
  const info: ProcessInfo = { pid, name, cmdline: cmdlineTokens.join(' '), exe: exeLink };
  const winExes = deriveWindowsExes(exeLink, cmdlineTokens, comm);
  if (winExes) {
    info.winExes = winExes;
    const cwd = readCwd(dir);
    if (cwd) info.cwd = cwd;
  }
  return info;
}

// ─── Platform process listing (fallback for non-Linux, or /proc unavailable) ─

function getProcessCommand(): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    return { executable: 'tasklist', args: ['/fo', 'csv', '/nh'] };
  }
  if (process.platform === 'darwin') {
    return { executable: 'ps', args: ['-c', '-A', '-o', 'comm'] };
  }
  // Linux and other Unix
  return { executable: 'ps', args: ['-A', '-o', 'comm'] };
}

/**
 * Parse `ps`/`tasklist` output into lowercased process names.
 * Kept for Windows/macOS and as a Linux fallback when /proc is unavailable.
 */
export function parseProcessList(stdout: string, platform: string = process.platform): Set<string> {
  const names = new Set<string>();

  if (platform === 'win32') {
    // Windows tasklist CSV: "ImageName","PID","SessionName","Session#","MemUsage"
    for (const line of stdout.split('\n')) {
      const match = line.match(/^"([^"]+)"/);
      if (match && match[1]) {
        names.add(match[1].toLowerCase());
      }
    }
  } else {
    // macOS/Linux: one process name per line, first line may be header
    const lines = stdout.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const name = lines[i]?.trim();
      if (!name) continue;
      // Skip header line (COMM or COMMAND)
      if (i === 0 && (name === 'COMM' || name === 'COMMAND')) continue;
      names.add(name.toLowerCase());
    }
  }

  return names;
}

/** Build ProcessInfo-like rows from a parsed name set (ps/tasklist fallback). */
function infosFromNames(names: Set<string>): ProcessInfo[] {
  return [...names].map((name) => ({ pid: 0, name, cmdline: '', exe: null }));
}

// ─── Matching ───────────────────────────────────────────────────────────────

/** A resolved game, whichever source produced it. */
export interface MatchedGame {
  id: string;
  name: string;
  type: string;
}

/**
 * A source detector resolves a running process to an installed game the
 * dictionary does not know (Steam libraries, Flatpak, GOG, ...). Returning
 * null lets the next source try.
 */
export type SourceDetector = (info: ProcessInfo) => MatchedGame | null;

/**
 * Steam games: first by the launch command of the supervising `reaper`
 * process (it names the app id, which is the only thing a Proton game's own
 * processes do not), then by the install directory holding the executable.
 */
export function createSteamSourceDetector(loadGames: () => SteamGame[] = () => loadSteamIndex()): SourceDetector {
  return (info) => {
    const games = loadGames();
    const game = findSteamGameForLaunch(info.cmdline, games) ?? findSteamGameForProcess(info.exe, games);
    return game ? { id: `steam-${game.appId}`, name: game.name, type: 'playing' } : null;
  };
}

const steamSourceDetector = createSteamSourceDetector();

const flatpakSourceDetector: SourceDetector = (info) => {
  const game = findFlatpakGameForProcess(info.exe, loadFlatpakIndex());
  return game ? { id: `flatpak-${game.appId}`, name: game.name, type: 'playing' } : null;
};

const gogSourceDetector: SourceDetector = (info) => {
  const game = findGogGameForProcess(info.exe, info.cmdline, loadGogIndex());
  return game ? { id: `gog-${game.id}`, name: game.name, type: 'playing' } : null;
};

/** Heroic, Bottles and Lutris: games that run under Wine are named by the launcher that installed them. */
const launcherSourceDetector: SourceDetector = (info) => {
  const game = findLauncherGameForProcess(info, loadLauncherIndex());
  return game ? { id: game.id, name: game.name, type: 'playing' } : null;
};

const sourceDetectors: SourceDetector[] = [steamSourceDetector, flatpakSourceDetector, gogSourceDetector, launcherSourceDetector];

/**
 * Whether a running process matches a dictionary entry:
 * - exact process-name match (case-insensitive), or
 * - Linux comm truncation: dictionary name longer than 15 chars whose first
 *   15 chars equal the process name, or
 * - any cmdline pattern appearing in the process command line.
 * A Wine process is also matched by the Windows programs it may run (`winExes`).
 */
/**
 * Detects whether OBS Studio (or Streamlabs Desktop) is actively streaming.
 * Checks the latest session log file for streaming start/stop markers.
 */
export function isObsStreaming(): boolean {
  try {
    const candidateDirs: string[] = [];
    if (process.platform === 'win32') {
      if (process.env.APPDATA) {
        candidateDirs.push(path.join(process.env.APPDATA, 'obs-studio', 'logs'));
        candidateDirs.push(path.join(process.env.APPDATA, 'slobs-client', 'node-obs', 'logs'));
      }
      const home = os.homedir();
      candidateDirs.push(path.join(home, 'AppData', 'Roaming', 'obs-studio', 'logs'));
      candidateDirs.push(path.join(home, 'AppData', 'Roaming', 'slobs-client', 'node-obs', 'logs'));
    } else if (process.platform === 'darwin') {
      const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
      candidateDirs.push(path.join(appSupport, 'obs-studio', 'logs'));
      candidateDirs.push(path.join(appSupport, 'slobs-client', 'node-obs', 'logs'));
    } else {
      if (process.env.XDG_CONFIG_HOME) {
        candidateDirs.push(path.join(process.env.XDG_CONFIG_HOME, 'obs-studio', 'logs'));
      }
      const home = os.homedir();
      candidateDirs.push(path.join(home, '.config', 'obs-studio', 'logs'));
      candidateDirs.push(path.join(home, '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio', 'logs'));
    }

    for (const dir of candidateDirs) {
      if (!dir || !fs.existsSync(dir)) continue;

      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt') || f.endsWith('.log'));
      } catch {
        continue;
      }
      if (files.length === 0) continue;

      // Find the most recently modified log file
      let latestFile = '';
      let latestMtime = 0;
      for (const file of files) {
        try {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            latestFile = fullPath;
          }
        } catch {
          // ignore stat errors on individual files
        }
      }

      if (!latestFile) continue;

      // Ignore stale logs not modified in the last 24 hours
      if (Date.now() - latestMtime > 24 * 60 * 60 * 1000) {
        continue;
      }

      let content = '';
      try {
        const stat = fs.statSync(latestFile);
        if (stat.size <= 1024 * 1024) {
          content = fs.readFileSync(latestFile, 'utf-8');
        } else {
          const bufferSize = 1024 * 1024;
          const buffer = Buffer.alloc(bufferSize);
          const fd = fs.openSync(latestFile, 'r');
          try {
            fs.readSync(fd, buffer, 0, bufferSize, stat.size - bufferSize);
            content = buffer.toString('utf-8');
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch {
        continue;
      }

      const startIdx = Math.max(
        content.lastIndexOf('==== Streaming Start ='),
        content.lastIndexOf('Stream output started'),
      );
      const stopIdx = Math.max(
        content.lastIndexOf('==== Streaming Stop ='),
        content.lastIndexOf('Stream output stopped'),
      );

      if (startIdx !== -1 && startIdx > stopIdx) {
        return true;
      }
    }
  } catch (err) {
    console.warn('[ActivityDetector] Error checking OBS streaming status:', err);
  }
  return false;
}

export function matchesProcessName(entry: GameEntry, procName: string, cmdline: string, winExes?: readonly string[]): boolean {
  if ((entry.id === 'obs' || entry.id === 'streamlabs') && !isObsStreaming()) {
    return false;
  }
  // A Wine process answers to the Windows programs it may run as well as to its loader
  for (const candidate of winExes ? [procName, ...winExes] : [procName]) {
    const nameLower = candidate.toLowerCase();
    for (const proc of entry.processes) {
      const p = proc.toLowerCase();
      if (nameLower === p) return true;
      if (p.length > COMM_MAX && nameLower.length === COMM_MAX && p.startsWith(nameLower)) return true;
    }
  }

  if (entry.cmdlinePatterns && cmdline) {
    const cmdLower = cmdline.toLowerCase();
    for (const pattern of entry.cmdlinePatterns) {
      if (pattern && cmdLower.includes(pattern.toLowerCase())) return true;
    }
  }

  return false;
}

/**
 * First dictionary entry (dictionary order = priority) matched by any of the
 * running processes. A game entry listed before a launcher entry wins when
 * both are running — e.g. Minecraft before "Minecraft Launcher".
 */
export function findMatchingGame(infos: ProcessInfo[], entries: GameEntry[]): GameEntry | null {
  for (const entry of entries) {
    for (const info of infos) {
      if (matchesProcessName(entry, info.name, info.cmdline, info.winExes)) return entry;
    }
  }
  return null;
}

/**
 * Resolve the current activity: the dictionary wins when it matches (its
 * curated names take priority), and source detectors fill the gaps for any
 * installed game the dictionary does not list. First source to claim a
 * process wins; sources are tried in registration order.
 */
export function detectActivity(
  infos: ProcessInfo[],
  entries: GameEntry[],
  sources: SourceDetector[] = sourceDetectors,
): MatchedGame | null {
  return detectActivityWithInfo(infos, entries, sources).matched;
}

/**
 * `detectActivity` plus the process that produced the match: the icon
 * extractor needs the executable (an AppImage's `.DirIcon`, icons next to
 * the binary) in addition to the matched game's identity.
 */
export function detectActivityWithInfo(
  infos: ProcessInfo[],
  entries: GameEntry[],
  sources: SourceDetector[] = sourceDetectors,
): { matched: MatchedGame | null; info: ProcessInfo | null } {
  const dictionaryMatch = findMatchingGame(infos, entries);
  if (dictionaryMatch) {
    const info = matchInfoFor(dictionaryMatch.id, infos, entries);
    return {
      matched: { id: dictionaryMatch.id, name: dictionaryMatch.name, type: dictionaryMatch.type ?? 'playing' },
      info,
    };
  }

  for (const source of sources) {
    for (const info of infos) {
      const match = source(info);
      if (match) return { matched: match, info };
    }
  }
  return { matched: null, info: null };
}

/** Most games shown at once; the server accepts the same number of activities. */
export const MAX_DETECTED_GAMES = 5;

/** A program the player tied their game to: the status shows while it runs. */
export interface ManualBinding {
  name: string;
  /** What `ProcessInfo.name` (or a Wine program name) must equal, ignoring case. */
  process: string;
}

const MANUAL_ID = 'manual';
const MAX_BINDING_FIELD = 256;

export function parseManualBinding(value: unknown): ManualBinding | null {
  if (!value || typeof value !== 'object') return null;
  const { name, process: proc } = value as Record<string, unknown>;
  if (typeof name !== 'string' || typeof proc !== 'string') return null;
  const cleanName = name.trim();
  const cleanProc = proc.trim();
  if (cleanName === '' || cleanProc === '') return null;
  if (cleanName.length > MAX_BINDING_FIELD || cleanProc.length > MAX_BINDING_FIELD) return null;
  return { name: cleanName, process: cleanProc };
}

const MAX_MANUAL_BINDINGS = 50;

/** Tie the player's games to running programs (an empty or invalid list clears them) and look again right away. */
export function setManualBindings(value: unknown): void {
  const list = Array.isArray(value) ? value : [];
  const bindings: ManualBinding[] = [];
  for (const item of list.slice(0, MAX_MANUAL_BINDINGS)) {
    const binding = parseManualBinding(item);
    if (binding && !bindings.some((b) => b.process.toLowerCase() === binding.process.toLowerCase())) bindings.push(binding);
  }
  manualBindings = bindings;
  if (intervalId) poll();
}

export function getManualBindings(): readonly ManualBinding[] {
  return manualBindings;
}

/** One game: the channel of clients that predate the list. */
export function setManualBinding(value: unknown): void {
  const binding = parseManualBinding(value);
  setManualBindings(binding ? [binding] : []);
}

/**
 * Wine programs that are running but belong to no detected game: what the
 * player may be asked about ("a program was found that I do not know").
 * Processes of a detected game (same process, or the same working directory:
 * its helpers and crash reporters) are not unknown.
 */
export function findUnknownWinePrograms(infos: ProcessInfo[], games: DetectedGame[]): RunningProgram[] {
  const claimedPids = new Set<number>();
  const claimedDirs: string[] = [];
  for (const { info } of games) {
    if (!info) continue;
    if (info.pid > 0) claimedPids.add(info.pid);
    if (info.cwd) claimedDirs.push(info.cwd);
  }
  const seen = new Map<string, RunningProgram>();
  for (const info of infos) {
    const program = info.winExes?.[0];
    if (!program || !/\.exe$/i.test(program)) continue;
    if (claimedPids.has(info.pid)) continue;
    if (info.cwd && claimedDirs.some((dir) => info.cwd === dir || info.cwd!.startsWith(dir + '/') || dir.startsWith(info.cwd + '/'))) continue;
    const key = program.toLowerCase();
    if (!seen.has(key)) seen.set(key, { label: program.replace(/\.exe$/i, ''), process: program });
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(0, 20);
}

let unknownWinePrograms: RunningProgram[] = [];

/** The unknown Wine programs of the last scan (the settings hint polls this). */
export function getUnknownWinePrograms(): RunningProgram[] {
  return unknownWinePrograms;
}

export interface RunningProgram {
  /** What the picker shows and the game defaults to. */
  label: string;
  /** What the binding matches on. */
  process: string;
}

const SYSTEM_PATH = /^\/(usr|bin|sbin|lib|lib32|lib64|etc|snap|run|proc|sys|var)\//;
const MAX_RUNNING_PROGRAMS = 300;

/**
 * Programs the player can tie their game to: their own processes, minus the
 * system's (anything run from /usr, /bin, ...). A Wine program is offered by
 * its Windows name, not by the loader's.
 */
export function listRunningPrograms(procRoot = '/proc', uid: number | null = process.getuid?.() ?? null): RunningProgram[] {
  let infos: ProcessInfo[];
  try {
    infos = readProcessInfos(procRoot);
  } catch {
    return [];
  }
  const seen = new Map<string, RunningProgram>();
  for (const info of infos) {
    if (uid !== null) {
      try {
        if (fs.statSync(path.join(procRoot, String(info.pid))).uid !== uid) continue;
      } catch {
        continue;
      }
    }
    const windows = info.winExes?.[0];
    const program = windows ?? info.name;
    if (!windows && info.exe && SYSTEM_PATH.test(info.exe)) continue;
    const label = windows ? windows.replace(/\.exe$/i, '') : info.name;
    const key = program.toLowerCase();
    if (!seen.has(key)) seen.set(key, { label, process: program });
  }
  return [...seen.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(0, MAX_RUNNING_PROGRAMS);
}

export interface DetectedGame {
  matched: MatchedGame;
  info: ProcessInfo | null;
}

/** A launcher or client is not what the player is playing while a game runs. */
export function isLauncherGame(game: MatchedGame): boolean {
  return /launcher/i.test(game.name) || /launcher/i.test(game.id);
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Every game that is running, not just the first: dictionary matches in
 * dictionary order, then the games the source detectors resolve. A game found
 * twice (two processes, or a store and the dictionary) is listed once, under
 * the dictionary's name. A launcher is dropped as soon as a real game runs.
 */
export function detectActivitiesWithInfo(
  infos: ProcessInfo[],
  entries: GameEntry[],
  sources: SourceDetector[] = sourceDetectors,
  max: number = MAX_DETECTED_GAMES,
  manual: readonly ManualBinding[] | ManualBinding | null = null,
): DetectedGame[] {
  const found: DetectedGame[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const claimedPids = new Set<number>();
  const add = (matched: MatchedGame, info: ProcessInfo | null): void => {
    ids.add(matched.id);
    names.add(`${matched.type}:${nameKey(matched.name)}`);
    if (info && info.pid > 0) claimedPids.add(info.pid);
    found.push({ matched, info });
  };

  // The player's own game comes first and takes every process it matches, so
  // the dictionary and the stores cannot list the same game a second time
  const bindings = manual === null ? [] : Array.isArray(manual) ? manual : [manual as ManualBinding];
  for (const binding of bindings) {
    const id = `${MANUAL_ID}:${binding.process.toLowerCase()}`;
    const entry: GameEntry = { id, name: binding.name, processes: [binding.process] };
    const running = infos.filter((info) => matchesProcessName(entry, info.name, info.cmdline, info.winExes));
    const first = running[0];
    if (first && !ids.has(id)) {
      add({ id, name: binding.name, type: 'playing' }, first);
      for (const info of running) if (info.pid > 0) claimedPids.add(info.pid);
    }
  }

  for (const entry of entries) {
    const info = matchInfoFor(entry.id, infos, entries);
    if (info && info.pid > 0 && claimedPids.has(info.pid)) continue;
    if (info && !ids.has(entry.id)) {
      add({ id: entry.id, name: entry.name, type: entry.type ?? 'playing' }, info);
    }
  }

  for (const source of sources) {
    for (const info of infos) {
      if (info.pid > 0 && claimedPids.has(info.pid)) continue;
      const match = source(info);
      if (!match || ids.has(match.id)) continue;
      if (names.has(`${match.type}:${nameKey(match.name)}`)) continue;
      add(match, info);
    }
  }

  const hasRealGame = found.some(({ matched }) => matched.type === 'playing' && !isLauncherGame(matched));
  const visible = hasRealGame
    ? found.filter(({ matched }) => !(matched.type === 'playing' && isLauncherGame(matched)))
    : found;
  return visible.slice(0, max);
}

/** The process a dictionary match came from: the first info the entry's matchers accept. */
function matchInfoFor(id: string, infos: ProcessInfo[], entries: GameEntry[]): ProcessInfo | null {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  for (const info of infos) {
    if (matchesProcessName(entry, info.name, info.cmdline, info.winExes)) return info;
  }
  return null;
}

// ─── Dictionary loading ─────────────────────────────────────────────────────

/**
 * Parse and validate a game entry from the dictionary.
 * `processes` may be empty only when `cmdlinePatterns` carries the matching.
 */
export function parseGameEntry(entry: unknown): GameEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;

  const hasPatterns = Array.isArray(e.cmdlinePatterns) && e.cmdlinePatterns.length > 0 &&
    e.cmdlinePatterns.every((p: unknown) => typeof p === 'string' && p.length > 0);

  if (typeof e.id !== 'string' || !e.id || typeof e.name !== 'string' || !e.name ||
      !Array.isArray(e.processes) ||
      !e.processes.every((p: unknown) => typeof p === 'string' && p.length > 0) ||
      (e.processes.length === 0 && !hasPatterns)) {
    return null;
  }

  const type = typeof e.type === 'string' && VALID_TYPES.has(e.type) ? e.type : 'playing';

  return {
    id: e.id,
    name: e.name,
    processes: e.processes as string[],
    cmdlinePatterns: hasPatterns ? (e.cmdlinePatterns as string[]) : undefined,
    type,
  };
}

/**
 * Validate a parsed dictionary object (bare array = legacy version 0, or a
 * versioned `{ version, games }` object) without touching module state.
 */
export function validateDictionaryObject(parsed: unknown): {
  version: number;
  entries: GameEntry[];
} | null {
  let version = 0;
  let rawEntries: unknown[];

  if (Array.isArray(parsed)) {
    rawEntries = parsed;
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.version === 'number' && Array.isArray(obj.games)) {
      version = obj.version;
      rawEntries = obj.games;
    } else {
      return null;
    }
  } else {
    return null;
  }

  const entries: GameEntry[] = [];
  for (const entry of rawEntries) {
    const gameEntry = parseGameEntry(entry);
    if (gameEntry) entries.push(gameEntry);
  }

  if (entries.length === 0) return null;
  return { version, entries };
}

/** Read and validate a dictionary file. Returns null when missing/corrupt. */
export function loadDictionaryFile(filePath: string): { version: number; entries: GameEntry[]; raw: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const validated = validateDictionaryObject(parsed);
  if (!validated) return null;
  return { version: validated.version, entries: validated.entries, raw };
}

/**
 * Atomically write data to a file by writing to a .tmp file first,
 * then renaming it into place.
 */
function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Load the best local dictionary: cache and bundled seed are both read, and
 * whichever carries the higher version wins. When the seed wins it is
 * promoted into the cache so a fresh install immediately benefits from the
 * remote-sync ETag flow and future boots compare against the right version.
 *
 * Returns null when neither source yields a valid dictionary.
 */
export function loadBestDictionary(cachePath: string, seedPath: string): {
  version: number;
  entries: GameEntry[];
} | null {
  const cache = loadDictionaryFile(cachePath);
  const seed = loadDictionaryFile(seedPath);

  const winner = !cache && !seed
    ? null
    : !cache
      ? seed
      : !seed
        ? cache
        : (seed.version > cache.version ? seed : cache);

  if (!winner) return null;

  // Promote a winning seed into the cache (best-effort)
  if (winner === seed) {
    try {
      atomicWrite(cachePath, seed.raw);
    } catch (err) {
      console.warn('[ActivityDetector] Failed to promote seed dictionary to cache:', err);
    }
  }

  return { version: winner.version, entries: winner.entries };
}

// ─── Remote sync ────────────────────────────────────────────────────────────

function getCachePath(): string {
  return path.join(app.getPath('userData'), 'games-cache.json');
}

function getETagPath(): string {
  return path.join(app.getPath('userData'), 'games-cache-etag.txt');
}

function readETag(): string | null {
  try {
    return fs.readFileSync(getETagPath(), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function writeETag(etag: string): void {
  try {
    fs.writeFileSync(getETagPath(), etag, 'utf-8');
  } catch {
    // Non-critical — next sync will just re-download
  }
}

/**
 * Fetch a URL over HTTPS and return the response body and headers.
 * Supports conditional requests via If-None-Match.
 */
function fetchRemote(url: string, etag: string | null): Promise<{
  status: number;
  body: string;
  etag: string | null;
} | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      'User-Agent': 'Backspace-Desktop/1.0',
    };
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    const req = https.get(url, { headers, timeout: 10_000 }, (res) => {
      if (res.statusCode === 304) {
        resolve({ status: 304, body: '', etag: null });
        res.resume(); // Drain the response
        return;
      }

      // Follow single redirect (GitHub raw may 301/302)
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume();
        fetchRemote(res.headers.location, etag).then(resolve).catch(() => resolve(null));
        return;
      }

      if (res.statusCode !== 200) {
        resolve(null);
        res.resume();
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const responseEtag = typeof res.headers.etag === 'string' ? res.headers.etag : null;
        resolve({ status: 200, body, etag: responseEtag });
      });
      res.on('error', () => resolve(null));
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Sync the game dictionary from a remote source.
 *
 * Strategy:
 * 1. Local state already holds the best local version (max of cache/seed),
 *    loaded by startActivityDetection.
 * 2. Fetch from GitHub in the background (conditional on the stored ETag).
 * 3. If the remote version is newer, atomically write to cache, save ETag,
 *    and hot-swap the in-memory entries.
 */
async function syncDictionary(): Promise<void> {
  const cachePath = getCachePath();
  const currentVersion = dictionaryVersion;
  const etag = readETag();

  let response: { status: number; body: string; etag: string | null } | null;
  try {
    response = await fetchRemote(REMOTE_URL, etag);
  } catch {
    console.log('[ActivityDetector] Remote sync fetch failed — continuing with local dictionary');
    return;
  }

  if (!response) {
    console.log('[ActivityDetector] Remote sync failed (network error) — continuing with local dictionary');
    return;
  }

  if (response.status === 304) {
    console.log('[ActivityDetector] Remote dictionary unchanged (304)');
    return;
  }

  if (response.status !== 200) {
    console.log(`[ActivityDetector] Remote sync returned status ${response.status} — skipping`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    console.warn('[ActivityDetector] Remote dictionary contains malformed JSON — skipping');
    return;
  }

  const validated = validateDictionaryObject(parsed);
  if (!validated) {
    console.warn('[ActivityDetector] Remote dictionary validation failed — skipping');
    return;
  }

  // Only apply if version is newer
  if (validated.version <= currentVersion) {
    console.log(`[ActivityDetector] Remote version (${validated.version}) is not newer than local (${currentVersion}) — skipping`);
    // Still save ETag so we get 304 next time
    if (response.etag) {
      writeETag(response.etag);
    }
    return;
  }

  try {
    atomicWrite(cachePath, response.body);
  } catch (err) {
    console.warn('[ActivityDetector] Failed to write cache:', err);
    // Non-fatal — we can still hot-swap in memory
  }

  if (response.etag) {
    writeETag(response.etag);
  }

  gameEntries = validated.entries;
  dictionaryVersion = validated.version;
  console.log(`[ActivityDetector] Hot-swapped to remote dictionary v${validated.version} (${validated.entries.length} games)`);
}

// ─── Poll logic ─────────────────────────────────────────────────────────────

/**
 * Apply a matched game (or its absence) to the scan layer of the detection
 * state, then refresh the effective activity.
 */
function applyDetectedGames(games: DetectedGame[], infos: ProcessInfo[] = []): void {
  unknownWinePrograms = findUnknownWinePrograms(infos, games);
  for (const { matched, info } of games) {
    void warmGameIcon({
      id: matched.id,
      name: matched.name,
      exe: info?.exe ?? null,
      cmdline: info?.cmdline ?? '',
      winExes: info?.winExes,
      cwd: info?.cwd ?? null,
    });
  }
  scanActivities = nextScanActivities(games.map((game) => game.matched), scanActivities, Date.now());
  refreshEffectiveActivity();
}

/**
 * The scan layer's activity for one poll. While the same game keeps running
 * the previous activity is returned unchanged, so its `timestamps.start`
 * stays the moment the game was first seen: rebuilding it on every 15s poll
 * restarted the elapsed clock and made every poll look like a change.
 */
export function nextScanActivity(
  matched: MatchedGame | null,
  previous: Activity | null,
  now: number,
): Activity | null {
  if (!matched) return null;
  if (previous && previous.name === matched.name && previous.type === matched.type) return previous;
  return { type: matched.type, name: matched.name, timestamps: { start: now } };
}

/**
 * The scan layer for one poll, several games at once. Each game that is still
 * running keeps its previous activity object, so every game keeps its own
 * start time.
 */
export function nextScanActivities(
  matched: MatchedGame[],
  previous: Activity[],
  now: number,
): Activity[] {
  return matched.map((game) => nextScanActivity(game, previous.find((p) => p.name === game.name && p.type === game.type) ?? null, now) as Activity);
}

/**
 * The activities shown: the scan layer, where a live IPC push stands in for
 * the scanned game it belongs to (same name; it is richer: real details, map
 * state, art), or leads the list when the scan found no such game.
 */
export function mergeActivities(scan: Activity[], override: Activity | null, max: number = MAX_DETECTED_GAMES): Activity[] {
  if (!override) return scan.slice(0, max);
  const key = nameKey(override.name);
  const at = scan.findIndex((activity) => activity.type === override.type && nameKey(activity.name) === key);
  if (at === -1) return [override, ...scan].slice(0, max);
  return scan.map((activity, i) => (i === at ? override : activity)).slice(0, max);
}

/**
 * The effective activity is the IPC push when one is live (richer: real
 * details, map state, art), otherwise the scan-detected game. A change is
 * emitted only when the effective activity actually changed.
 */
function refreshEffectiveActivity(): void {
  const effective = mergeActivities(scanActivities, ipcOverride);
  if (JSON.stringify(effective) === JSON.stringify(currentActivities)) return;
  const primaryChanged = JSON.stringify(effective[0] ?? null) !== JSON.stringify(currentActivities[0] ?? null);
  currentActivities = effective;
  console.log(
    `[ActivityDetector] Effective activities: ${
      effective.length
        ? effective.map((a) => `${a.name} (${a === ipcOverride ? 'ipc' : 'scan'}${a.details ? ', details' : ''})`).join(', ')
        : 'none'
    }`,
  );
  // The single-activity callback only serves clients that predate the list
  if (primaryChanged) onChangeCallback?.(currentActivities[0] ?? null);
  onListChangeCallback?.(currentActivities);
}

// ─── IPC overlay (IPC-pushed activities) ────────────────────────────────────

/**
 * Client ids of apps known to push rich presence without a name of their
 * own; their pushes get this display name when neither the push nor the
 * process dictionary can supply one.
 */
const KNOWN_CLIENT_APPS: Record<string, string> = {
  // osu!lazer's desktop client
  '1216669957799018608': 'osu!lazer',
};

/**
 * Resolve a display name for an IPC push by looking its pid up in the
 * dictionary: the /proc entry of the pushing process, matched like a scan.
 * `procRoot` is injectable for tests.
 */
export function resolveIpcGameName(pid: number | null, procRoot = '/proc'): string | null {
  if (pid === null || pid <= 0) return null;
  const info = readProcessInfoByPid(pid, procRoot);
  if (!info) return null;
  const entry = findMatchingGame([info], gameEntries);
  return entry ? entry.name : null;
}

/**
 * Overlay an IPC-pushed activity over process detection. A null push
 * clears the overlay and falls back to the scan-detected game. Changes take
 * effect immediately — a map switch is visible within a second, not on the
 * next 15s poll.
 */
export function applyIpcActivity(push: IpcActivityPush | null): void {
  if (!push) {
    ipcOverride = null;
  } else {
    const a = push.activity;
    // Resolve the display name step by step so the log can say where it
    // came from: the push itself, the /proc dictionary lookup, a known
    // client id, or the last-resort fallback.
    const pushedName = a.name ?? null;
    const procName = pushedName ? null : resolveIpcGameName(push.pid);
    const knownName = KNOWN_CLIENT_APPS[push.clientId] ?? null;
    const name = pushedName ?? procName ?? knownName ?? 'Unknown game';
    let nameSource = 'fallback';
    if (pushedName) nameSource = 'push';
    else if (procName) nameSource = 'process lookup';
    else if (knownName) nameSource = 'known client id';
    console.log(
      `[ActivityDetector] IPC activity: client=${push.clientId} pid=${push.pid ?? 'none'}` +
      ` name=${JSON.stringify(name)} (${nameSource})` +
      ` details=${a.details ? JSON.stringify(a.details) : 'none'}` +
      ` state=${a.state ? 'yes' : 'no'}` +
      ` timestamps=${a.timestamps ? 'yes' : 'no'}` +
      ` assets=${a.assets ? 'yes' : 'no'}`,
    );
    ipcOverride = {
      type: a.type,
      name,
      details: a.details,
      state: a.state,
      timestamps: a.timestamps,
      assets: a.assets,
    };
    // The icon is resolved from the pushing process's own executable in the
    // background; the renderer uploads it to the instance on first ask.
    void warmGameIconForIpc(name, push.pid);
  }
  refreshEffectiveActivity();
}

/** Test seam: inject the scan-detected activity without touching /proc. */
export function __testSetScanActivity(activity: Activity | null): void {
  scanActivities = activity ? [activity] : [];
  refreshEffectiveActivity();
}

/** Test seam: several scan-detected activities. */
export function __testSetScanActivities(activities: Activity[]): void {
  scanActivities = activities;
  refreshEffectiveActivity();
}

function poll(): void {
  if (isPolling) return; // Previous poll still in-flight
  isPolling = true;

  if (process.platform === 'linux') {
    // Direct /proc walk: full executable names, command lines, no subprocess
    let infos: ProcessInfo[];
    try {
      infos = readProcessInfos();
    } catch (err) {
      console.warn('[ActivityDetector] /proc scan failed:', err, '— falling back to ps');
      // Keep isPolling set: pollViaCommand's callback releases it
      pollViaCommand();
      return;
    }
    isPolling = false;
    applyDetectedGames(detectActivitiesWithInfo(infos, gameEntries, undefined, undefined, manualBindings), infos);
    return;
  }

  pollViaCommand();
}

function pollViaCommand(): void {
  const { executable, args } = getProcessCommand();

  execFile(executable, args, { maxBuffer: 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
    isPolling = false;

    if (error) {
      if (!hasErrored) {
        console.warn('[ActivityDetector] execFile failed:', error.message, '— stopping detection');
        hasErrored = true;
        stopActivityDetection();
      }
      return;
    }

    const rawString = typeof stdout === 'string' ? stdout : decodeWin32Output(stdout);
    const infos = infosFromNames(parseProcessList(rawString));
    applyDetectedGames(detectActivitiesWithInfo(infos, gameEntries, undefined, undefined, manualBindings), infos);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startActivityDetection(
  onActivityChange: (activity: Activity | null) => void,
  onActivitiesChange?: (activities: Activity[]) => void,
): void {
  if (intervalId) return; // Already running

  const cachePath = getCachePath();
  const seedPath = path.join(__dirname, '..', 'resources', 'games.json');

  const best = loadBestDictionary(cachePath, seedPath);
  if (!best) {
    console.warn('[ActivityDetector] No valid dictionary found — detection disabled');
    return;
  }

  gameEntries = best.entries;
  dictionaryVersion = best.version;
  console.log(`[ActivityDetector] Loaded ${best.entries.length} games v${best.version}`);

  onChangeCallback = onActivityChange;
  onListChangeCallback = onActivitiesChange ?? null;
  hasErrored = false;

  // Run first poll immediately
  poll();

  // Then poll every 15 seconds
  intervalId = setInterval(poll, POLL_INTERVAL_MS);

  // Fire-and-forget: sync from remote in background
  syncDictionary().catch((err) => {
    console.warn('[ActivityDetector] Sync failed:', err);
  });
}

export function stopActivityDetection(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  onChangeCallback = null;
  onListChangeCallback = null;
}

export function getCurrentActivity(): Activity | null {
  return currentActivities[0] ?? null;
}

export function getCurrentActivities(): Activity[] {
  return currentActivities;
}

const MAX_KNOWN_GAME_NAMES = 5000;

/**
 * Names the picker offers as suggestions: the dictionary plus every game this
 * machine has installed through Steam, Flatpak or GOG. Deduplicated without
 * regard to case and sorted; a player may still type any other name.
 */
export function listKnownGameNames(): string[] {
  const seen = new Map<string, string>();
  const add = (name: string) => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  };
  for (const entry of gameEntries) {
    if ((entry.type ?? 'playing') === 'playing') add(entry.name);
  }
  for (const loader of [loadSteamIndex, loadFlatpakIndex, loadGogIndex, loadLauncherIndex]) {
    try {
      for (const game of loader()) add(game.name);
    } catch {
      // A source that cannot be read contributes no suggestions
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_KNOWN_GAME_NAMES);
}

export function getAllCurrentActivities(): Activity[] {
  return getCurrentActivities();
}

export interface TrackedApp {
  entry: GameEntry;
  firstSeenAt: number;
  lastStartedAt: number;
}

export function resolveActiveActivity(
  tracked: Map<string, TrackedApp>,
  enablePreemption: boolean,
  currentId: string | null,
): TrackedApp | null {
  if (tracked.size === 0) return null;
  const list = Array.from(tracked.values());
  if (enablePreemption) {
    list.sort((a, b) => b.lastStartedAt - a.lastStartedAt);
    return list[0] ?? null;
  }
  if (currentId && tracked.has(currentId)) {
    return tracked.get(currentId)!;
  }
  list.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  return list[0] ?? null;
}

