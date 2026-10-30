import fs from 'fs';
import path from 'path';
import type { GameIcon, GameIconTarget } from './types';

export const MAX_ICON_BYTES = 512 * 1024;
const MAX_DESKTOP_FILE_BYTES = 64 * 1024;
const MAX_DESKTOP_FILES = 2000;
export const HICOLOR_SIZE_DIRS = [
  '512x512', '384x384', '256x256', '192x192', '128x128',
  '96x96', '64x64', '48x48', '32x32', '24x24', '16x16',
];
const EXE_DIR_ICON_NAMES = ['.DirIcon', 'icon.png', 'Icon.png', 'icon_256.png', 'logo.png', 'cover.png'];

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

export async function readIconFile(file: string): Promise<GameIcon | null> {
  let bytes: Buffer;
  try {
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

export async function firstExistingIcon(files: string[]): Promise<GameIcon | null> {
  for (const file of files) {
    const icon = await readIconFile(file);
    if (icon) return icon;
  }
  return null;
}

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

export interface DesktopEntry {
  exec: string;
  name: string;
  icon: string;
}

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

const HOST_PROGRAMS = /^(java|javaw|python[\d.]*|wine(64|-preloader|loader)?|mono|dotnet|node|nodejs|electron|ruby|perl|lua|luajit|love|sh|bash|dash|zsh|env|flatpak|bwrap|steam|reaper|proton|gamescope|gamemoderun|mangohud|ld-linux[\w.-]*|pressure-vessel[\w-]*|steam-runtime[\w-]*)$/i;

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
      for (const size of HICOLOR_SIZE_DIRS) candidates.push(path.join(root, size, 'apps', base));
    }
    candidates.push(path.join('/usr', 'share', 'pixmaps', base));
  }
  return candidates;
}

function iconFromDesktopEntry(entry: DesktopEntry, home: string): string[] {
  if (entry.icon.startsWith('/')) return [entry.icon];
  return themedIconCandidates(entry.icon, home);
}

export async function genericIcon(target: GameIconTarget, home: string): Promise<GameIcon | null> {
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

export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
