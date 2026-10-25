import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseLibraryFoldersVdf,
  parseAppManifest,
  getSteamRoots,
  loadSteamIndex,
  resetSteamIndexCache,
  findSteamGameForProcess,
  findSteamGameForLaunch,
  isSteamToolApp,
} from './steamGames';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const VDF = `"libraryfolders"
{
  "0"
  {
    "path"    "/home/tester/.local/share/Steam"
    "label"   ""
    "contentid" "1234"
    "totalsize" "0"
  }
  "1"
  {
    "path"    "/mnt/games/Steam Library"
    "label"   "HDD"
  }
  "2"
  {
    "path"    "/media/data/lib"
  }
}
`;

const ACF = (over: Record<string, string> = {}) => {
  const fields = {
    appid: '424242',
    name: 'Sonic & All-Stars Racing',
    installdir: 'Sonic All-Stars Racing Transformed',
    StateFlags: '4',
    ...over,
  };
  return `"AppState"
{
  "appid"      "${fields.appid}"
  "Universe"   "1"
  "name"       "${fields.name}"
  "StateFlags" "${fields.StateFlags}"
  "installdir" "${fields.installdir}"
  "LastUpdated" "1700000000"
}
`;
};

interface ManifestSpec {
  appId: string;
  name: string;
  installdir: string;
  stateFlags?: string;
}

/**
 * Build a fake Steam installation under a fresh tmp home:
 *   <home>/.local/share/Steam/steamapps/libraryfolders.vdf → lists every lib
 *   <lib>/steamapps/appmanifest_<appid>.acf                → manifests
 * Extra manifests can be written by the caller into primaryApps(home).
 */
function makeSteamTree(libs: Array<{ dir: string; manifests: ManifestSpec[] }>): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-home-')));
  const steamRoot = path.join(home, '.local', 'share', 'Steam');
  fs.mkdirSync(path.join(steamRoot, 'steamapps'), { recursive: true });

  const libEntries = libs.map((l, i) => `  "${i + 1}"\n  {\n    "path"    "${l.dir}"\n  }`);
  fs.writeFileSync(
    path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n  "0"\n  {\n    "path"    "${steamRoot}"\n  }\n${libEntries.join('\n')}\n}\n`,
  );

  for (const lib of libs) {
    const apps = path.join(lib.dir, 'steamapps');
    fs.mkdirSync(apps, { recursive: true });
    for (const m of lib.manifests) {
      fs.writeFileSync(
        path.join(apps, `appmanifest_${m.appId}.acf`),
        ACF({ appid: m.appId, name: m.name, installdir: m.installdir, StateFlags: m.stateFlags ?? '4' }),
      );
    }
  }
  return home;
}

const primaryApps = (home: string) => path.join(home, '.local', 'share', 'Steam', 'steamapps');

// ─── parseLibraryFoldersVdf ─────────────────────────────────────────────────

describe('parseLibraryFoldersVdf', () => {
  it('extracts every library path, spaces included', () => {
    expect(parseLibraryFoldersVdf(VDF)).toEqual([
      '/home/tester/.local/share/Steam',
      '/mnt/games/Steam Library',
      '/media/data/lib',
    ]);
  });

  it('returns an empty list for empty or corrupt input', () => {
    expect(parseLibraryFoldersVdf('')).toEqual([]);
    expect(parseLibraryFoldersVdf('"foo"\n{\n}')).toEqual([]);
  });
});

// ─── parseAppManifest ───────────────────────────────────────────────────────

describe('parseAppManifest', () => {
  it('extracts appid, name, installdir and the installed flag', () => {
    const m = parseAppManifest(ACF());
    expect(m).toEqual({
      appId: 424242,
      name: 'Sonic & All-Stars Racing',
      installdir: 'Sonic All-Stars Racing Transformed',
      fullyInstalled: true,
    });
  });

  it('marks non-fully-installed apps as not installed', () => {
    expect(parseAppManifest(ACF({ StateFlags: '6' }))?.fullyInstalled).toBe(true); // 6 = 2|4
    expect(parseAppManifest(ACF({ StateFlags: '2' }))?.fullyInstalled).toBe(false);
    expect(parseAppManifest(ACF({ StateFlags: '1026' }))?.fullyInstalled).toBe(false); // update running, not complete
  });

  it('returns null when required fields are missing or invalid', () => {
    expect(parseAppManifest('')).toBeNull();
    expect(parseAppManifest('"AppState"\n{\n}')).toBeNull();
    expect(parseAppManifest(ACF({ appid: 'nope' }))).toBeNull();
    expect(parseAppManifest(ACF({ installdir: '' }))).toBeNull();
    expect(parseAppManifest(ACF({ StateFlags: 'X' }))).toBeNull();
  });

  it('unescapes quotes and backslashes in names', () => {
    const m = parseAppManifest('"AppState"\n{\n  "appid" "1"\n  "name" "Crysis\\" Warhead"\n  "installdir" "d"\n  "StateFlags" "4"\n}');
    expect(m?.name).toBe('Crysis" Warhead');
  });
});

// ─── getSteamRoots ──────────────────────────────────────────────────────────

describe('getSteamRoots', () => {
  it('finds the native root and drops missing packagings', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-roots-'));
    fs.mkdirSync(path.join(home, '.local', 'share', 'Steam', 'steamapps'), { recursive: true });
    const roots = getSteamRoots(home);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(fs.realpathSync(path.join(home, '.local', 'share', 'Steam')));
  });

  it('deduplicates ~/.steam/steam and the native data dir to one root', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-roots2-'));
    const native = path.join(home, '.local', 'share', 'Steam');
    fs.mkdirSync(path.join(native, 'steamapps'), { recursive: true });
    fs.mkdirSync(path.join(home, '.steam'), { recursive: true });
    fs.symlinkSync(native, path.join(home, '.steam', 'steam'));
    expect(getSteamRoots(home)).toHaveLength(1);
  });

  it('returns an empty list when Steam is not installed', () => {
    expect(getSteamRoots(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-none-')))).toEqual([]);
  });
});

// ─── loadSteamIndex ─────────────────────────────────────────────────────────

describe('loadSteamIndex', () => {
  beforeEach(() => resetSteamIndexCache());

  it('indexes every installed game across all libraries', () => {
    const extHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-ext-')));
    const extLib = path.join(extHome, 'SteamLibrary');
    const steamHome = makeSteamTree([
      { dir: extLib, manifests: [{ appId: '570', name: 'Dota 2', installdir: 'dota 2 beta' }] },
    ]);
    // A game in the primary library too
    fs.writeFileSync(
      path.join(primaryApps(steamHome), 'appmanifest_440.acf'),
      ACF({ appid: '440', name: 'Team Fortress 2', installdir: 'Team Fortress 2' }),
    );

    const games = loadSteamIndex(getSteamRoots(steamHome));
    const byId = new Map(games.map((g) => [g.appId, g]));
    expect(byId.get(440)?.name).toBe('Team Fortress 2');
    expect(byId.get(440)?.installDir).toBe(path.join(primaryApps(steamHome), 'common', 'Team Fortress 2'));
    expect(byId.get(570)?.installDir).toBe(path.join(extLib, 'steamapps', 'common', 'dota 2 beta'));
  });

  it('skips manifests that are not fully installed', () => {
    const extHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-ext2-')));
    const extLib = path.join(extHome, 'SteamLibrary');
    const steamHome = makeSteamTree([
      { dir: extLib, manifests: [
        { appId: '10', name: 'CS 1.6', installdir: 'Counter-Strike', stateFlags: '4' },
        { appId: '20', name: 'Downloading Game', installdir: 'Partial', stateFlags: '1026' },
      ] },
    ]);
    const games = loadSteamIndex(getSteamRoots(steamHome));
    expect(games.map((g) => g.appId)).toEqual([10]);
  });

  it('caches the index within the TTL and refreshes after a reset', () => {
    const extHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-ext3-')));
    const extLib = path.join(extHome, 'SteamLibrary');
    const steamHome = makeSteamTree([
      { dir: extLib, manifests: [{ appId: '30', name: 'Half-Life', installdir: 'Half-Life' }] },
    ]);
    const roots = getSteamRoots(steamHome);

    const first = loadSteamIndex(roots);
    expect(first).toHaveLength(1);

    // New install lands while the cache is warm — invisible until reset/force
    fs.writeFileSync(
      path.join(extLib, 'steamapps', 'appmanifest_70.acf'),
      ACF({ appid: '70', name: 'Half-Life 2', installdir: 'Half-Life 2' }),
    );
    expect(loadSteamIndex(roots)).toHaveLength(1);
    expect(loadSteamIndex(roots, true)).toHaveLength(2);
    resetSteamIndexCache();
    expect(loadSteamIndex(roots)).toHaveLength(2);
  });
});

// ─── findSteamGameForProcess ────────────────────────────────────────────────

describe('findSteamGameForProcess', () => {
  const games = [
    { appId: 440, name: 'Team Fortress 2', installDir: '/home/u/.local/share/Steam/steamapps/common/Team Fortress 2' },
    { appId: 570, name: 'Dota 2', installDir: '/mnt/games/Steam Library/steamapps/common/dota 2 beta' },
  ];

  it('matches a native game exe under the install directory', () => {
    expect(findSteamGameForProcess('/home/u/.local/share/Steam/steamapps/common/Team Fortress 2/hl2_linux', games)?.appId).toBe(440);
  });

  it('matches a Proton game exe (path under common/, case differs)', () => {
    expect(findSteamGameForProcess('/home/u/.local/share/steam/steamapps/common/team fortress 2/hl2.exe', games)?.appId).toBe(440);
  });

  it('matches games in a secondary library on another disk', () => {
    expect(findSteamGameForProcess('/mnt/games/Steam Library/steamapps/common/dota 2 beta/game/bin/linuxsteamrt64/dota2', games)?.appId).toBe(570);
  });

  it('rejects exe paths outside every install directory', () => {
    expect(findSteamGameForProcess('/usr/bin/obs', games)).toBeNull();
    // compatdata prefixes are Wine prefixes, not install dirs
    expect(findSteamGameForProcess('/home/u/.local/share/Steam/steamapps/compatdata/440/pfx/drive_c/users/u/game.exe', games)).toBeNull();
  });

  it('rejects sibling directories that merely share a name prefix', () => {
    expect(findSteamGameForProcess('/home/u/.local/share/Steam/steamapps/common/Team Fortress 2 Beta/hl2_linux', games)).toBeNull();
  });

  it('returns null without an exe path', () => {
    expect(findSteamGameForProcess(null, games)).toBeNull();
  });
});

// ─── Steam's own tools are not games ────────────────────────────────────────

describe('Steam tool apps', () => {
  beforeEach(() => resetSteamIndexCache());

  it('are told apart by name or install directory', () => {
    expect(isSteamToolApp('Steam Linux Runtime 3.0 (sniper)', 'SteamLinuxRuntime_sniper')).toBe(true);
    expect(isSteamToolApp('Steam Linux Runtime 4.0', 'SteamLinuxRuntime_4')).toBe(true);
    expect(isSteamToolApp('Proton 9.0 (Beta)', 'Proton 9.0')).toBe(true);
    expect(isSteamToolApp('Proton Experimental', 'Proton - Experimental')).toBe(true);
    expect(isSteamToolApp('Steamworks Common Redistributables', 'Steamworks Shared')).toBe(true);
    expect(isSteamToolApp('ELDEN RING', 'ELDEN RING')).toBe(false);
    expect(isSteamToolApp('Protonmail Simulator', 'Protonmail Simulator')).toBe(false);
    expect(isSteamToolApp('Steam Hunters', 'SteamHunters')).toBe(false);
  });

  it('never reach the index, so their processes are never the activity', () => {
    const steamHome = makeSteamTree([]);
    const apps = primaryApps(steamHome);
    fs.writeFileSync(path.join(apps, 'appmanifest_1628350.acf'),
      ACF({ appid: '1628350', name: 'Steam Linux Runtime 3.0 (sniper)', installdir: 'SteamLinuxRuntime_sniper' }));
    fs.writeFileSync(path.join(apps, 'appmanifest_2805730.acf'),
      ACF({ appid: '2805730', name: 'Proton 9.0 (Beta)', installdir: 'Proton 9.0' }));
    fs.writeFileSync(path.join(apps, 'appmanifest_1245620.acf'),
      ACF({ appid: '1245620', name: 'ELDEN RING', installdir: 'ELDEN RING' }));

    const games = loadSteamIndex(getSteamRoots(steamHome));
    expect(games.map((g) => g.name)).toEqual(['ELDEN RING']);
    const runtimeExe = path.join(apps, 'common', 'SteamLinuxRuntime_sniper', 'pressure-vessel', 'bin', 'bwrap');
    expect(findSteamGameForProcess(runtimeExe, games)).toBeNull();
  });
});

describe('findSteamGameForLaunch', () => {
  const games = [
    { appId: 1245620, name: 'ELDEN RING', installDir: '/lib/steamapps/common/ELDEN RING' },
    { appId: 70, name: 'Half-Life', installDir: '/lib/steamapps/common/Half-Life' },
  ];

  it('reads the app id from the reaper launch command, native or Proton', () => {
    const proton = '/home/u/.local/share/Steam/ubuntu12_32/reaper SteamLaunch AppId=1245620 -- '
      + '/home/u/.local/share/Steam/steamapps/common/SteamLinuxRuntime_sniper/_v2-entry-point '
      + '--verb=waitforexitandrun -- /home/u/.local/share/Steam/steamapps/common/Proton 9.0/proton waitforexitandrun '
      + '/lib/steamapps/common/ELDEN RING/Game/eldenring.exe';
    expect(findSteamGameForLaunch(proton, games)?.name).toBe('ELDEN RING');
    expect(findSteamGameForLaunch('/x/reaper SteamLaunch AppId=70 -- /lib/steamapps/common/Half-Life/hl.sh', games)?.name)
      .toBe('Half-Life');
  });

  it('is null for anything that is not a launch of an indexed game', () => {
    expect(findSteamGameForLaunch('/usr/bin/steam', games)).toBeNull();
    expect(findSteamGameForLaunch('/x/reaper SteamLaunch AppId=999 -- /x', games)).toBeNull();
    expect(findSteamGameForLaunch('/x/reaper SteamLaunch AppId=7 -- /x', games)).toBeNull(); // 70 is not 7
    expect(findSteamGameForLaunch('/x/reaper SteamLaunch AppId=70abc -- /x', games)).toBeNull();
    expect(findSteamGameForLaunch('echo NotSteamLaunch AppId=70', games)).toBeNull();
  });
});
