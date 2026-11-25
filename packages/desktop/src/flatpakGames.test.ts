import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseDesktopCategories,
  parseDesktopName,
  desktopHasGameCategory,
  isLauncherAppId,
  getFlatpakInstallDirs,
  loadFlatpakIndex,
  resetFlatpakIndexCache,
  findFlatpakGameForProcess,
} from './flatpakGames';

// ─── .desktop parsing ───────────────────────────────────────────────────────

describe('.desktop parsing', () => {
  it('splits the Categories line into tokens', () => {
    expect(parseDesktopCategories('Categories=Game;Strategy;')).toEqual(['Game', 'Strategy']);
    expect(parseDesktopCategories('Categories=Utility;')).toEqual(['Utility']);
  });

  it('detects the Game category', () => {
    expect(desktopHasGameCategory('[Desktop Entry]\nCategories=Game;BoardGame;\n')).toBe(true);
    expect(desktopHasGameCategory('[Desktop Entry]\nCategories=Game\n')).toBe(true);
    expect(desktopHasGameCategory('[Desktop Entry]\nCategories=Utility;Graphics;\n')).toBe(false);
    expect(desktopHasGameCategory('[Desktop Entry]\n')).toBe(false);
  });

  it('extracts the bare Name over localized entries', () => {
    expect(parseDesktopName('[Desktop Entry]\nName[de]=Super Schach\nName=Super Chess\n')).toBe('Super Chess');
    expect(parseDesktopName('[Desktop Entry]\nName=Super Chess\n')).toBe('Super Chess');
    expect(parseDesktopName('[Desktop Entry]\nName[de]=Nur Lokalisiert\n')).toBeNull();
  });

  it('flags known launcher app-ids and keeps real games', () => {
    expect(isLauncherAppId('com.valvesoftware.Steam')).toBe(true);
    expect(isLauncherAppId('net.lutris.Lutris')).toBe(true);
    expect(isLauncherAppId('com.usebottles.bottles')).toBe(true);
    expect(isLauncherAppId('com.heroicgameslauncher.hgl')).toBe(true);
    expect(isLauncherAppId('io.itch.itch')).toBe(true);
    expect(isLauncherAppId('org.prismlauncher.PrismLauncher')).toBe(true);
    expect(isLauncherAppId('com.endlessnetwork.superchess')).toBe(false);
  });
});

// ─── index ──────────────────────────────────────────────────────────────────

interface FlatpakSpec {
  appId: string;
  name: string;
  categories: string;
  launcher?: boolean;
}

function makeFlatpakInstall(specs: FlatpakSpec[]): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flatpak-home-')));
  const install = path.join(home, '.local', 'share', 'flatpak');
  for (const spec of specs) {
    const filesDir = path.join(install, 'app', spec.appId, 'x86_64', 'stable', 'active', 'files', 'bin');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, 'run'), '#!/bin/sh\n');
    const exports = path.join(install, 'exports', 'share', 'applications');
    fs.mkdirSync(exports, { recursive: true });
    fs.writeFileSync(
      path.join(exports, `${spec.appId}.desktop`),
      `[Desktop Entry]\nType=Application\nName=${spec.name}\nCategories=${spec.categories};\n`,
    );
  }
  return home;
}

describe('loadFlatpakIndex', () => {
  beforeEach(() => resetFlatpakIndexCache());

  it('indexes Game-category apps with their files dir, excluding launchers', () => {
    const home = makeFlatpakInstall([
      { appId: 'com.endlessnetwork.superchess', name: 'Super Chess', categories: 'Game;BoardGame' },
      { appId: 'org.gimp.GIMP', name: 'GIMP', categories: 'Graphics' },
      { appId: 'net.lutris.Lutris', name: 'Lutris', categories: 'Game' },
    ]);
    const install = path.join(home, '.local', 'share', 'flatpak');
    const games = loadFlatpakIndex([install], true);
    expect(games.map((g) => g.appId)).toEqual(['com.endlessnetwork.superchess']);
    expect(games[0]?.name).toBe('Super Chess');
    expect(games[0]?.filesDir).toBe(path.join(install, 'app', 'com.endlessnetwork.superchess', 'x86_64', 'stable', 'active', 'files'));
  });

  it('skips apps without an exported desktop file', () => {
    const home = makeFlatpakInstall([]);
    const install = path.join(home, '.local', 'share', 'flatpak');
    const appDir = path.join(install, 'app', 'org.hidden.Game', 'x86_64', 'stable', 'active', 'files');
    fs.mkdirSync(appDir, { recursive: true });
    const games = loadFlatpakIndex([install], true);
    expect(games).toEqual([]);
  });

  it('caches within the TTL', () => {
    const home = makeFlatpakInstall([
      { appId: 'org.example.chess', name: 'Chess', categories: 'Game' },
    ]);
    const install = path.join(home, '.local', 'share', 'flatpak');
    expect(loadFlatpakIndex([install], true)).toHaveLength(1);

    makeFlatpakInstall([{ appId: 'org.example.checkers', name: 'Checkers', categories: 'Game' }]);
    // Second install goes to a different tmp home — the cached call ignores args
    resetFlatpakIndexCache();
    expect(loadFlatpakIndex([install])).toHaveLength(1);
  });
});

// ─── matching ───────────────────────────────────────────────────────────────

describe('findFlatpakGameForProcess', () => {
  const games = [
    {
      appId: 'com.endlessnetwork.superchess',
      name: 'Super Chess',
      filesDir: '/home/u/.local/share/flatpak/app/com.endlessnetwork.superchess/x86_64/stable/active/files',
    },
  ];

  it('matches an exe inside the sandbox files dir', () => {
    expect(findFlatpakGameForProcess('/home/u/.local/share/flatpak/app/com.endlessnetwork.superchess/x86_64/stable/active/files/bin/chess', games)?.appId)
      .toBe('com.endlessnetwork.superchess');
  });

  it('does not match sibling apps or outside paths', () => {
    expect(findFlatpakGameForProcess('/home/u/.local/share/flatpak/app/com.endlessnetwork.superchess2/x86_64/stable/active/files/bin/chess', games)).toBeNull();
    expect(findFlatpakGameForProcess('/usr/bin/firefox', games)).toBeNull();
    expect(findFlatpakGameForProcess(null, games)).toBeNull();
  });
});

// ─── install dirs ───────────────────────────────────────────────────────────

describe('getFlatpakInstallDirs', () => {
  it('finds the user install dir and skips missing system dirs', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flatpak-roots-'));
    fs.mkdirSync(path.join(home, '.local', 'share', 'flatpak'), { recursive: true });
    const dirs = getFlatpakInstallDirs(home, [path.join(home, 'system-flatpak')]);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(path.join(home, '.local', 'share', 'flatpak'));
  });

  it('appends existing system dirs after the user dir', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flatpak-roots-'));
    fs.mkdirSync(path.join(home, '.local', 'share', 'flatpak'), { recursive: true });
    const system = path.join(home, 'system-flatpak');
    fs.mkdirSync(system, { recursive: true });
    expect(getFlatpakInstallDirs(home, [system])).toEqual([
      path.join(home, '.local', 'share', 'flatpak'),
      system,
    ]);
  });
});
