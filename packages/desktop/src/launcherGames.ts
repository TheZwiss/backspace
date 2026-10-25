import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Games installed through Heroic, Bottles and Lutris.
 *
 * These launchers run most games under Wine, so the process the scanner sees
 * is a Wine loader and the game is known by the Windows program it runs and
 * by the folder it runs in (`ProcessInfo.winExes` / `cwd`). Each launcher
 * keeps its own list of installed games on disk; reading it gives the game's
 * real name, which no dictionary has to know. Every file is read defensively:
 * a layout this code does not understand yields no games, never an error, and
 * the running program is then still offered to the player by hand.
 */

export type LauncherKind = 'heroic' | 'bottles' | 'lutris';

export interface LauncherGame {
  /** `heroic-<runner>-<app>`, `bottles-<bottle>-<program>` or `lutris-<slug>` */
  id: string;
  name: string;
  kind: LauncherKind;
  /** Lowercased executable file names the game may run as (`game.exe`). */
  exeNames: string[];
  /** Host directory the game runs from; null when the launcher does not say. */
  dir: string | null;
  /** An icon image the launcher keeps for the game, when it does. */
  iconPath: string | null;
}

const INDEX_TTL_MS = 60_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_GAMES_PER_SOURCE = 2000;

let indexCache: { at: number; home: string; games: LauncherGame[] } | null = null;

// ─── Locations ──────────────────────────────────────────────────────────────

export function heroicConfigDirs(home: string): string[] {
  return [
    path.join(home, '.config', 'heroic'),
    path.join(home, '.var', 'app', 'com.heroicgameslauncher.hgl', 'config', 'heroic'),
  ];
}

export function bottlesDirs(home: string): string[] {
  return [
    path.join(home, '.local', 'share', 'bottles', 'bottles'),
    path.join(home, '.var', 'app', 'com.usebottles.bottles', 'data', 'bottles', 'bottles'),
  ];
}

export function lutrisConfigDirs(home: string): string[] {
  return [
    path.join(home, '.config', 'lutris', 'games'),
    path.join(home, '.var', 'app', 'net.lutris.Lutris', 'config', 'lutris', 'games'),
  ];
}

export function lutrisIconDirs(home: string): string[] {
  const sizes = ['128x128', '256x256', '64x64', '48x48'];
  const roots = [
    path.join(home, '.local', 'share', 'icons', 'hicolor'),
    path.join(home, '.var', 'app', 'net.lutris.Lutris', 'data', 'icons', 'hicolor'),
  ];
  return roots.flatMap((root) => sizes.map((size) => path.join(root, size, 'apps')));
}

// ─── Safe reading ───────────────────────────────────────────────────────────

function readText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The last path component of a Windows or POSIX path. */
export function baseName(file: string): string {
  const parts = file.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? '';
}

function exeNamesOf(...paths: Array<string | null>): string[] {
  const names = new Set<string>();
  for (const file of paths) {
    if (!file) continue;
    const name = baseName(file).toLowerCase();
    if (/\.exe$/.test(name)) names.add(name);
  }
  return [...names];
}

function absoluteDir(dir: string | null): string | null {
  return dir && path.isAbsolute(dir) ? dir : null;
}

// ─── A small YAML reader ────────────────────────────────────────────────────

/**
 * Nested block mappings with scalar values: all that bottle.yml and a Lutris
 * game config need. Lists, anchors and multi-line scalars are skipped, not
 * parsed. A mapping with no children is an empty object.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; map: Record<string, unknown> }> = [{ indent: -1, map: root }];

  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(rawLine) || /^\s*-/.test(rawLine) || /^---/.test(rawLine)) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    const key = readYamlKey(line);
    if (!key) continue;
    while (stack.length > 1 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop();
    const parent = (stack[stack.length - 1] as { map: Record<string, unknown> }).map;

    const rest = line.slice(key.end).trim();
    if (rest === '' || rest.startsWith('#')) {
      const child: Record<string, unknown> = {};
      parent[key.name] = child;
      stack.push({ indent, map: child });
    } else {
      parent[key.name] = readYamlScalar(rest);
    }
  }
  return root;
}

function readYamlKey(line: string): { name: string; end: number } | null {
  const quote = line[0];
  if (quote === '"' || quote === "'") {
    let name = '';
    let i = 1;
    for (; i < line.length; i++) {
      const ch = line[i] as string;
      if (quote === "'" && ch === "'" && line[i + 1] === "'") { name += "'"; i++; continue; }
      if (quote === '"' && ch === '\\' && i + 1 < line.length) { name += line[i + 1]; i++; continue; }
      if (ch === quote) break;
      name += ch;
    }
    if (line[i] !== quote || line[i + 1] !== ':') return null;
    return { name, end: i + 2 };
  }
  const match = /^([^:#][^:]*?):(?:\s|$)/.exec(line);
  if (!match || match[1] === undefined) return null;
  return { name: match[1].trim(), end: match[0].length };
}

function readYamlScalar(raw: string): string | null {
  if (raw === '~' || raw === 'null') return null;
  const quote = raw[0];
  if (quote === "'" || quote === '"') {
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const ch = raw[i] as string;
      if (quote === "'" && ch === "'" && raw[i + 1] === "'") { out += "'"; i++; continue; }
      if (quote === '"' && ch === '\\' && i + 1 < raw.length) { out += raw[i + 1]; i++; continue; }
      if (ch === quote) return out;
      out += ch;
    }
    return out;
  }
  return raw.replace(/\s+#.*$/, '').trim();
}

function asMap(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

// ─── Heroic ─────────────────────────────────────────────────────────────────

function readHeroic(configDir: string): LauncherGame[] {
  const games: LauncherGame[] = [];

  // Epic (legendary): { "<AppName>": { title, install_path, executable } }
  const epic = readJson(path.join(configDir, 'legendaryConfig', 'legendary', 'installed.json'));
  if (isRecord(epic)) {
    for (const [appName, entry] of Object.entries(epic)) {
      if (!isRecord(entry)) continue;
      const name = str(entry.title);
      if (!name) continue;
      games.push(heroicGame('epic', appName, name, str(entry.install_path), str(entry.executable)));
    }
  }

  // GOG: installed.json lists installs, the title lives in the game's own goggame info
  const gog = readJson(path.join(configDir, 'gog_store', 'installed.json'));
  const gogInstalled = isRecord(gog) && Array.isArray(gog.installed) ? gog.installed : [];
  const gogLibrary = readJson(path.join(configDir, 'gog_store', 'library.json'));
  const gogTitles = new Map<string, string>();
  if (isRecord(gogLibrary) && Array.isArray(gogLibrary.games)) {
    for (const game of gogLibrary.games) {
      if (isRecord(game)) {
        const id = str(game.app_name);
        const title = str(game.title);
        if (id && title) gogTitles.set(id, title);
      }
    }
  }
  for (const entry of gogInstalled) {
    if (!isRecord(entry)) continue;
    const appName = str(entry.appName);
    const installPath = str(entry.install_path);
    if (!appName) continue;
    const info = installPath ? readGogPlayTask(installPath, appName) : null;
    const name = gogTitles.get(appName) ?? info?.name ?? null;
    if (!name) continue;
    games.push(heroicGame('gog', appName, name, installPath, info?.exe ?? null));
  }

  // Amazon (nile): installed.json is a list of { id, path }; titles come from the library cache
  const nile = readJson(path.join(configDir, 'nile_config', 'nile', 'installed.json'));
  const nileLibrary = readJson(path.join(configDir, 'store_cache', 'nile_library.json'));
  const nileTitles = new Map<string, string>();
  const nileGames = isRecord(nileLibrary) && Array.isArray(nileLibrary.library) ? nileLibrary.library : Array.isArray(nileLibrary) ? nileLibrary : [];
  for (const game of nileGames) {
    if (isRecord(game)) {
      const id = str(game.app_name) ?? str(game.id);
      const title = str(game.title);
      if (id && title) nileTitles.set(id, title);
    }
  }
  if (Array.isArray(nile)) {
    for (const entry of nile) {
      if (!isRecord(entry)) continue;
      const id = str(entry.id);
      const name = id ? nileTitles.get(id) : null;
      if (id && name) games.push(heroicGame('amazon', id, name, str(entry.path), null));
    }
  }

  // Sideloaded: { games: [{ app_name, title, install: { executable } }] }
  const sideload = readJson(path.join(configDir, 'sideload_apps', 'library.json'));
  if (isRecord(sideload) && Array.isArray(sideload.games)) {
    for (const entry of sideload.games) {
      if (!isRecord(entry)) continue;
      const appName = str(entry.app_name);
      const name = str(entry.title);
      const install = asMap(entry.install);
      const executable = install ? str(install.executable) : null;
      if (!appName || !name) continue;
      const dir = executable && path.isAbsolute(executable) ? path.dirname(executable) : null;
      games.push(heroicGame('sideload', appName, name, dir, executable));
    }
  }

  return games.slice(0, MAX_GAMES_PER_SOURCE);
}

function heroicGame(runner: string, appName: string, name: string, installPath: string | null, executable: string | null): LauncherGame {
  return {
    id: `heroic-${runner}-${appName}`,
    name,
    kind: 'heroic',
    exeNames: exeNamesOf(executable),
    dir: absoluteDir(installPath),
    iconPath: null,
  };
}

/** The primary play task of a GOG install: `goggame-<id>.info` → playTasks[].path. */
function readGogPlayTask(installPath: string, appName: string): { name: string | null; exe: string | null } | null {
  const info = readJson(path.join(installPath, `goggame-${appName}.info`));
  if (!isRecord(info)) return null;
  const tasks = Array.isArray(info.playTasks) ? info.playTasks.filter(isRecord) : [];
  const primary = tasks.find((task) => task.isPrimary === true) ?? tasks[0];
  return { name: str(info.name), exe: primary ? str(primary.path) : null };
}

// ─── Bottles ────────────────────────────────────────────────────────────────

function readBottles(bottlesDir: string): LauncherGame[] {
  const games: LauncherGame[] = [];
  for (const bottle of readDir(bottlesDir)) {
    const bottleDir = path.join(bottlesDir, bottle);
    const text = readText(path.join(bottleDir, 'bottle.yml'));
    if (text === null) continue;
    const yaml = parseSimpleYaml(text);
    const programs = asMap(yaml.External_Programs) ?? asMap(yaml.Programs);
    if (!programs) continue;

    for (const [key, value] of Object.entries(programs)) {
      const program = asMap(value);
      if (!program) continue;
      const name = (typeof program.name === 'string' && program.name.trim()) || key;
      const executable = typeof program.executable === 'string' ? program.executable : null;
      const programPath = typeof program.path === 'string' ? program.path : null;
      const exeNames = exeNamesOf(executable, programPath);
      if (exeNames.length === 0) continue;
      const icon = path.join(bottleDir, 'icons', `${name}.png`);
      games.push({
        id: `bottles-${bottle}-${key}`,
        name,
        kind: 'bottles',
        exeNames,
        // A Windows path says nothing about the host folder; a host path does
        dir: programPath && path.isAbsolute(programPath) ? path.dirname(programPath) : null,
        iconPath: fs.existsSync(icon) ? icon : null,
      });
    }
  }
  return games.slice(0, MAX_GAMES_PER_SOURCE);
}

// ─── Lutris ─────────────────────────────────────────────────────────────────

/** "zenless-zone-zero" → "Zenless Zone Zero": the name when the config has none. */
export function nameFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function readLutris(gamesDir: string, iconDirs: string[]): LauncherGame[] {
  const games: LauncherGame[] = [];
  for (const file of readDir(gamesDir)) {
    const match = /^(.+)-\d+\.ya?ml$/.exec(file);
    if (!match || match[1] === undefined) continue;
    const slug = match[1];
    const text = readText(path.join(gamesDir, file));
    if (text === null) continue;
    const yaml = parseSimpleYaml(text);
    const game = asMap(yaml.game);
    if (!game) continue;

    const exe = typeof game.exe === 'string' ? game.exe : null;
    const workingDir = typeof game.working_dir === 'string' ? game.working_dir : null;
    const exeNames = exeNamesOf(exe);
    const dir = absoluteDir(workingDir) ?? (exe && path.isAbsolute(exe) ? path.dirname(exe) : null);
    if (exeNames.length === 0 && !dir) continue;

    const configName = typeof yaml.name === 'string' && yaml.name.trim() ? yaml.name.trim() : null;
    const icon = iconDirs.map((d) => path.join(d, `lutris_${slug}.png`)).find((candidate) => fs.existsSync(candidate)) ?? null;
    games.push({
      id: `lutris-${slug}`,
      name: configName ?? nameFromSlug(slug),
      kind: 'lutris',
      exeNames,
      dir,
      iconPath: icon,
    });
  }
  return games.slice(0, MAX_GAMES_PER_SOURCE);
}

// ─── Index ──────────────────────────────────────────────────────────────────

export function resetLauncherIndexCache(): void {
  indexCache = null;
}

/** Every game the three launchers report, cached for 60 seconds. force=true bypasses. */
export function loadLauncherIndex(home: string = os.homedir(), force = false): LauncherGame[] {
  if (!force && indexCache && indexCache.home === home && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return indexCache.games;
  }
  const games: LauncherGame[] = [];
  for (const dir of heroicConfigDirs(home)) games.push(...readHeroic(dir));
  for (const dir of bottlesDirs(home)) games.push(...readBottles(dir));
  const iconDirs = lutrisIconDirs(home);
  for (const dir of lutrisConfigDirs(home)) games.push(...readLutris(dir, iconDirs));
  indexCache = { at: Date.now(), home, games };
  return games;
}

// ─── Matching ───────────────────────────────────────────────────────────────

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

function isUnder(target: string | undefined | null, dir: string): boolean {
  if (!target) return false;
  const t = normalizePath(target);
  const d = normalizePath(dir);
  return d.length > 0 && (t === d || t.startsWith(d + '/'));
}

/** The process facts the matcher needs (a subset of the detector's ProcessInfo). */
export interface LauncherProcess {
  exe: string | null;
  cmdline: string;
  winExes?: string[];
  cwd?: string;
}

/**
 * The launcher game a running process belongs to.
 *
 * A Wine process matches by the Windows program it runs; where the launcher
 * names the game's folder, the process must also run from it (a bare name like
 * `game.exe` is not unique). A native process matches by living under the
 * game's folder.
 */
export function findLauncherGameForProcess(info: LauncherProcess, games: LauncherGame[]): LauncherGame | null {
  const wine = info.winExes?.map((name) => name.toLowerCase()) ?? [];
  const cmdline = normalizePath(info.cmdline);
  for (const game of games) {
    if (wine.length > 0) {
      const named = game.exeNames.length === 0 || game.exeNames.some((name) => wine.includes(name));
      if (!named) continue;
      if (game.dir === null) {
        if (game.exeNames.length > 0) return game;
        continue;
      }
      if (isUnder(info.cwd, game.dir) || cmdline.includes(normalizePath(game.dir))) return game;
      continue;
    }
    if (game.dir === null) continue;
    if (isUnder(info.exe, game.dir)) return game;
    if (cmdline.includes(normalizePath(game.dir) + '/')) return game;
  }
  return null;
}
