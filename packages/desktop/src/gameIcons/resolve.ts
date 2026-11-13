import fs from 'fs';
import os from 'os';
import path from 'path';
import { genericIcon } from './files';
import { installedGameId } from './identify';
import {
  flatpakIcon,
  gogIcon,
  launcherIcon,
  macApplicationIcon,
  steamIcon,
  windowsProgramIcon,
} from './providers';
import type { GameIcon, GameIconTarget } from './types';

export async function findGameIcon(
  target: GameIconTarget,
  home: string = os.homedir(),
): Promise<GameIcon | null> {
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
  if (id.startsWith('lutris-') || id.startsWith('bottles-') || id.startsWith('heroic-')) {
    const icon = await launcherIcon(id, home);
    if (icon) return icon;
  }
  const fromWindows = await windowsProgramIcon(target);
  if (fromWindows) return fromWindows;
  const fromMac = await macApplicationIcon(target);
  if (fromMac) return fromMac;
  return genericIcon(target, home);
}

const iconCache = new Map<string, GameIcon | null>();
const iconWarming = new Map<string, Promise<void>>();

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

export function getGameIcon(name: string): GameIcon | null {
  return iconCache.get(name) ?? null;
}

export async function resolveGameIcon(name: string): Promise<GameIcon | null> {
  await warmGameIcon({ id: '', name, exe: null, cmdline: '' });
  return getGameIcon(name);
}

export function __testResetGameIconCache(): void {
  iconCache.clear();
  iconWarming.clear();
}
