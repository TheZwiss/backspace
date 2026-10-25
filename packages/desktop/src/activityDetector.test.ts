import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  pickProcName,
  deriveWindowsExes,
  readProcessInfos,
  readProcessInfoByPid,
  parseProcessList,
  matchesProcessName,
  findMatchingGame,
  detectActivity,
  createSteamSourceDetector,
  parseGameEntry,
  validateDictionaryObject,
  loadDictionaryFile,
  loadBestDictionary,
  startActivityDetection,
  stopActivityDetection,
  getCurrentActivity,
  applyIpcActivity,
  resolveIpcGameName,
  __testSetScanActivity,
  nextScanActivity,
  nextScanActivities,
  mergeActivities,
  detectActivitiesWithInfo,
  isLauncherGame,
  getCurrentActivities,
  __testSetScanActivities,
  MAX_DETECTED_GAMES,
  type SourceDetector,
  type ProcessInfo,
  parseManualBinding,
  setManualBinding,
  setManualBindings,
  getManualBindings,
  listRunningPrograms,
  findUnknownWinePrograms,
  isObsStreaming,
} from './activityDetector';
import type { IpcActivityPush, IpcActivityPayload } from './richPresenceIpc';

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-userdata' },
}));

// The suite runs with cwd = packages/desktop (vitest config dir)
const cwdSeed = path.join(process.cwd(), 'resources', 'games.json');
const seedPath = fs.existsSync(cwdSeed)
  ? cwdSeed
  : path.join(process.cwd(), 'packages', 'desktop', 'resources', 'games.json');

// ─── Fake /proc helpers ─────────────────────────────────────────────────────

interface FakeProc {
  pid: number;
  /** Symlink target for /proc/<pid>/exe; 'REGULAR' = a plain file (readlink fails); undefined = absent */
  exe?: string | 'REGULAR';
  /** NUL-separated argv tokens */
  cmdline?: string[];
  comm?: string;
  /** Symlink target for /proc/<pid>/cwd */
  cwd?: string;
}

function makeFakeProc(entries: FakeProc[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
  for (const e of entries) {
    const dir = path.join(root, String(e.pid));
    fs.mkdirSync(dir);
    if (e.exe === 'REGULAR') {
      fs.writeFileSync(path.join(dir, 'exe'), 'not-a-symlink');
    } else if (e.exe !== undefined) {
      // Symlink targets need not exist for readlink
      fs.symlinkSync(e.exe, path.join(dir, 'exe'));
    }
    if (e.cmdline) {
      fs.writeFileSync(path.join(dir, 'cmdline'), e.cmdline.join('\0') + '\0');
    }
    if (e.comm) {
      fs.writeFileSync(path.join(dir, 'comm'), e.comm + '\n');
    }
    if (e.cwd) fs.symlinkSync(e.cwd, path.join(dir, 'cwd'));
  }
  // Noise that exists in real /proc
  fs.mkdirSync(path.join(root, 'self'));
  fs.mkdirSync(path.join(root, 'sys'));
  fs.writeFileSync(path.join(root, 'stat'), 'cpu 1 2 3 4');
  return root;
}

// ─── pickProcName ───────────────────────────────────────────────────────────

describe('pickProcName', () => {
  it('prefers the exe symlink basename, wine paths included', () => {
    expect(pickProcName('/home/u/.wine/drive_c/Program Files/osu!/osu!.exe', [], null)).toBe('osu!.exe');
    expect(pickProcName('/usr/games/cs2', [], null)).toBe('cs2');
  });

  it('keeps the full name for AppImage-mounted binaries', () => {
    expect(pickProcName('/tmp/.mount_superTuxKXYZ/usr/bin/supertux2', [], null)).toBe('supertux2');
  });

  it('falls back to the first cmdline token basename when exe is unreadable', () => {
    expect(pickProcName(null, ['/usr/bin/python3', '-m', 'http.server'], null)).toBe('python3');
  });

  it('falls back to comm (possibly kernel-truncated) as a last resort', () => {
    expect(pickProcName(null, [], 'minecraft-launc')).toBe('minecraft-launc');
  });

  it('returns null when nothing is available (pure kernel thread)', () => {
    expect(pickProcName(null, [], null)).toBeNull();
  });
});

// ─── matchesProcessName ─────────────────────────────────────────────────────

describe('matchesProcessName', () => {
  const cs2 = { id: 'cs2', name: 'Counter-Strike 2', processes: ['cs2.exe', 'cs2'] };

  it('matches process names case-insensitively', () => {
    expect(matchesProcessName(cs2, 'CS2.exe', '')).toBe(true);
    expect(matchesProcessName(cs2, 'cs2', '')).toBe(true);
    expect(matchesProcessName(cs2, 'CS2', '')).toBe(true);
  });

  it('does not match unrelated names', () => {
    expect(matchesProcessName(cs2, 'csgo', '')).toBe(false);
    expect(matchesProcessName(cs2, 'cs2_beta', '')).toBe(false);
  });

  it('matches long dictionary names against kernel-truncated 15-char comm values', () => {
    const launcher = { id: 'l', name: 'L', processes: ['minecraft-launcher'] };
    expect(matchesProcessName(launcher, 'minecraft-launc', '')).toBe(true); // 15 chars
  });

  it('does not apply the truncation rule to shorter or divergent names', () => {
    const launcher = { id: 'l', name: 'L', processes: ['minecraft-launcher'] };
    expect(matchesProcessName(launcher, 'minecraft-laun', '')).toBe(false); // 14 chars
    expect(matchesProcessName(launcher, 'minecraft-launx', '')).toBe(false); // wrong 16th... wrong tail
    expect(matchesProcessName(launcher, 'minecraft-launc2', '')).toBe(false); // 16 chars, not truncated
  });

  it('requires exact match for dictionary names of 15 chars or fewer', () => {
    const short = { id: 's', name: 'S', processes: ['supertuxkart'] }; // 12 chars
    expect(matchesProcessName(short, 'supertuxkart', '')).toBe(true);
    expect(matchesProcessName(short, 'supertuxkar', '')).toBe(false);
  });

  it('matches cmdline patterns case-insensitively in the joined command line', () => {
    const mc = {
      id: 'minecraft',
      name: 'Minecraft',
      processes: [],
      cmdlinePatterns: ['net.fabricmc.loader.impl.launch.knot.knotclient'],
    };
    const cmdline = '/usr/lib/jvm/java-21/bin/java -Xmx2G -cp mods:libraries net.fabricmc.loader.impl.launch.knot.KnotClient --username herobrine';
    expect(matchesProcessName(mc, 'java', cmdline)).toBe(true);
  });

  it('matches an entry with empty processes through its patterns alone', () => {
    const mc = { id: 'minecraft', name: 'Minecraft', processes: [], cmdlinePatterns: ['net.minecraft.client.main.main'] };
    expect(matchesProcessName(mc, 'java', '/usr/bin/java net.minecraft.client.main.Main --version 1.21')).toBe(true);
    expect(matchesProcessName(mc, 'java', '/usr/bin/java -jar server.jar nogui')).toBe(false);
  });

  it('does not flag Minecraft servers or unrelated java processes', () => {
    const mc = { id: 'minecraft', name: 'Minecraft', processes: [], cmdlinePatterns: ['net.minecraft.client.main.main', '--launchtarget forgeclient'] };
    expect(matchesProcessName(mc, 'java', 'java -Xmx4G net.minecraft.server.Main nogui')).toBe(false);
    expect(matchesProcessName(mc, 'java', 'java --launchTarget forgeserver nogui')).toBe(false);
    expect(matchesProcessName(mc, 'java', 'java -jar modrinth-app.jar')).toBe(false);
    expect(matchesProcessName(mc, 'code', '/usr/share/code/code --type=renderer')).toBe(false);
  });
});

// ─── parseProcessList ───────────────────────────────────────────────────────

describe('parseProcessList', () => {
  it('parses Windows tasklist CSV output', () => {
    const out = '"cs2.exe","1234","Console","1","1,234 K"\n"explorer.exe","99","Console","1","56 K"\n';
    expect(parseProcessList(out, 'win32')).toEqual(new Set(['cs2.exe', 'explorer.exe']));
  });

  it('skips junk lines in tasklist output', () => {
    expect(parseProcessList('INFO: no tasks\n\n"obs64.exe","7","Console","1","2 K"\n', 'win32'))
      .toEqual(new Set(['obs64.exe']));
  });

  it('parses Linux ps output and skips the header', () => {
    const out = 'COMMAND\nsystemd\n  minecraft-launc\nPlasma\n';
    expect(parseProcessList(out, 'linux')).toEqual(new Set(['systemd', 'minecraft-launc', 'plasma']));
  });

  it('parses macOS ps -c output and skips the COMM header', () => {
    const out = 'COMM\nWindowServer\nOBS\n';
    expect(parseProcessList(out, 'darwin')).toEqual(new Set(['windowserver', 'obs']));
  });
});

// ─── readProcessInfos (fake /proc) ──────────────────────────────────────────

describe('readProcessInfos', () => {
  it('reads pid, name, cmdline and the full exe path for regular processes', () => {
    const root = makeFakeProc([
      { pid: 42, exe: '/usr/games/cs2', cmdline: ['/usr/games/cs2', '-novid'], comm: 'cs2' },
    ]);
    const infos = readProcessInfos(root);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toEqual({ pid: 42, name: 'cs2', cmdline: '/usr/games/cs2 -novid', exe: '/usr/games/cs2' });
  });

  it('resolves wine processes to the .exe basename and keeps the prefix path', () => {
    const root = makeFakeProc([
      { pid: 7, exe: '/home/u/.wine/drive_c/Program Files/osu!/osu!.exe', cmdline: ['C:\\\\Program Files\\\\osu!\\\\osu!.exe'], comm: 'osu!.exe' },
    ]);
    const infos = readProcessInfos(root);
    expect(infos[0]?.name).toBe('osu!.exe');
    expect(infos[0]?.exe).toBe('/home/u/.wine/drive_c/Program Files/osu!/osu!.exe');
  });

  it('falls back to comm when the exe symlink is unreadable and cmdline is empty', () => {
    const root = makeFakeProc([
      { pid: 9, exe: 'REGULAR', comm: 'minecraft-launc' },
    ]);
    const infos = readProcessInfos(root);
    expect(infos[0]?.name).toBe('minecraft-launc');
    expect(infos[0]?.cmdline).toBe('');
  });

  it('skips kernel threads with no name sources', () => {
    const root = makeFakeProc([
      { pid: 2, comm: 'kthreadd' }, // exe absent, cmdline absent → comm present though
      { pid: 3 }, // nothing at all
    ]);
    const infos = readProcessInfos(root);
    // pid 2 has comm → name kthreadd; pid 3 has nothing → skipped
    expect(infos.map((i) => i.pid)).toEqual([2]);
  });

  it('ignores exe targets marked (deleted)', () => {
    const root = makeFakeProc([
      { pid: 5, exe: '/tmp/AppRun (deleted)', cmdline: [], comm: 'app' },
    ]);
    const infos = readProcessInfos(root);
    expect(infos[0]?.name).toBe('app'); // comm wins because exe is ignored
  });

  it('ignores non-numeric /proc entries', () => {
    const root = makeFakeProc([{ pid: 11, exe: '/usr/bin/obs', comm: 'obs' }]);
    const infos = readProcessInfos(root);
    expect(infos.map((i) => i.pid)).toEqual([11]);
  });

  it('survives a missing /proc root', () => {
    expect(readProcessInfos(path.join(os.tmpdir(), 'definitely-not-here-12345'))).toEqual([]);
  });
});

describe('readProcessInfoByPid', () => {
  it('reads a single pid', () => {
    const root = makeFakeProc([
      { pid: 42, exe: '/usr/games/cs2', cmdline: ['/usr/games/cs2'], comm: 'cs2' },
    ]);
    expect(readProcessInfoByPid(42, root)).toEqual({ pid: 42, name: 'cs2', cmdline: '/usr/games/cs2', exe: '/usr/games/cs2' });
    expect(readProcessInfoByPid(999, root)).toBeNull();
  });
});

// ─── findMatchingGame and priority ──────────────────────────────────────────

describe('findMatchingGame', () => {
  const dict = [
    { id: 'cs2', name: 'Counter-Strike 2', processes: ['cs2.exe', 'cs2'] },
    { id: 'minecraft', name: 'Minecraft', processes: [], cmdlinePatterns: ['net.minecraft.client.main.main'] },
    { id: 'minecraft-launcher', name: 'Minecraft Launcher', processes: ['minecraft-launcher', 'prismlauncher'] },
  ];

  it('returns the first dictionary entry matched by any process', () => {
    const infos = [{ pid: 1, name: 'obs', cmdline: '', exe: null }, { pid: 2, name: 'cs2', cmdline: '', exe: null }];
    expect(findMatchingGame(infos, dict)?.id).toBe('cs2');
  });

  it('prefers the game over the launcher when both run (dictionary order)', () => {
    const infos = [
      { pid: 1, name: 'prismlauncher', cmdline: 'prismlauncher', exe: null },
      { pid: 2, name: 'java', cmdline: '/usr/bin/java net.minecraft.client.main.Main --username x', exe: null },
    ];
    expect(findMatchingGame(infos, dict)?.id).toBe('minecraft');
  });

  it('detects the launcher alone via the truncated comm', () => {
    const infos = [{ pid: 1, name: 'minecraft-launc', cmdline: 'minecraft-launcher', exe: null }];
    expect(findMatchingGame(infos, dict)?.id).toBe('minecraft-launcher');
  });

  it('returns null when nothing matches', () => {
    const infos = [{ pid: 1, name: 'systemd', cmdline: '/sbin/init', exe: null }];
    expect(findMatchingGame(infos, dict)).toBeNull();
  });
});

// ─── detectActivity: dictionary vs sources ──────────────────────────────────

describe('detectActivity', () => {
  const dict = [
    { id: 'tf2', name: 'Team Fortress 2', processes: ['tf2_linux', 'tf2_osx', 'tf_win64.exe'] },
  ];

  const steamSource: SourceDetector = (info) =>
    info.exe?.includes('/steamapps/common/')
      ? { id: 'steam-424242', name: 'Dictionaryless Steam Game', type: 'playing' }
      : null;

  it('prefers the dictionary over a source when both match', () => {
    const infos = [{ pid: 1, name: 'tf2_linux', cmdline: '', exe: '/x/steamapps/common/Team Fortress 2/hl2_linux' }];
    const match = detectActivity(infos, dict, [steamSource]);
    expect(match).toEqual({ id: 'tf2', name: 'Team Fortress 2', type: 'playing' });
  });

  it('falls through to sources for games the dictionary does not list', () => {
    const infos = [{ pid: 1, name: 'sonic-bin', cmdline: '', exe: '/x/steamapps/common/Sonic/sonic-bin' }];
    const match = detectActivity(infos, dict, [steamSource]);
    expect(match).toEqual({ id: 'steam-424242', name: 'Dictionaryless Steam Game', type: 'playing' });
  });

  it('tries sources in registration order and keeps the first claim', () => {
    const infos = [{ pid: 1, name: 'unknown', cmdline: '', exe: '/games/somewhere/game' }];
    const first: SourceDetector = () => ({ id: 'source-a', name: 'A', type: 'playing' });
    const second: SourceDetector = () => ({ id: 'source-b', name: 'B', type: 'playing' });
    expect(detectActivity(infos, dict, [first, second])?.id).toBe('source-a');
  });

  it('returns null when neither dictionary nor sources match', () => {
    const infos = [{ pid: 1, name: 'systemd', cmdline: '/sbin/init', exe: '/sbin/init' }];
    expect(detectActivity(infos, dict, [steamSource])).toBeNull();
  });
});

// ─── Seed dictionary contract ───────────────────────────────────────────────

describe('bundled seed dictionary (games.json v3)', () => {
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as { version: number; games: unknown[] };

  it('is versioned as v3', () => {
    expect(seed.version).toBe(3);
  });

  it('contains osu! for both wine and native lazer', () => {
    const osu = seed.games.find((g) => (g as { id: string }).id === 'osu') as { processes: string[] };
    expect(osu).toBeDefined();
    expect(osu.processes).toContain('osu!.exe');
    expect(osu.processes).toContain('osu!');
  });

  it('matches Minecraft by launcher-agnostic cmdline patterns', () => {
    const mc = seed.games.find((g) => (g as { id: string }).id === 'minecraft') as {
      processes: string[]; cmdlinePatterns?: string[];
    };
    expect(mc).toBeDefined();
    expect(mc.cmdlinePatterns?.length).toBeGreaterThanOrEqual(8);
    expect(mc.processes).not.toContain('java');
    expect(mc.processes).not.toContain('minecraft-launcher'); // moved to its own entry
  });

  it('lists the launcher entry after the game entry', () => {
    const ids = seed.games.map((g) => (g as { id: string }).id);
    expect(ids.indexOf('minecraft')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('minecraft-launcher')).toBeGreaterThan(ids.indexOf('minecraft'));
  });

  it('has unique ids and only parse-valid entries', () => {
    const ids = seed.games.map((g) => (g as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of seed.games) {
      expect(parseGameEntry(entry)).not.toBeNull();
    }
  });

  it('still detects the OBS regression case from the seed', () => {
    const obs = seed.games.find((g) => (g as { id: string }).id === 'obs') as { processes: string[] };
    expect(obs.processes).toContain('obs');
  });

  it('carries the native Linux titles without dedicated servers', () => {
    const ids = seed.games.map((g) => (g as { id: string }).id);
    for (const id of ['wesnoth', 'luanti', 'openmw', '0ad', 'supertuxkart', 'hl2', 'warzone2100', 'teeworlds', 'endless-sky', 'mindustry', 'xonotic']) {
      expect(ids).toContain(id);
    }
    const all = seed.games.flatMap((g) => (g as { processes: string[] }).processes);
    for (const server of ['wesnothd', 'minetestserver', 'luantiserver', 'teeworlds_srv']) {
      expect(all).not.toContain(server);
    }
  });
});

// ─── Dictionary parsing and loading ─────────────────────────────────────────

describe('parseGameEntry', () => {
  it('rejects entries with no processes and no patterns', () => {
    expect(parseGameEntry({ id: 'x', name: 'X', processes: [] })).toBeNull();
  });

  it('rejects empty pattern strings and non-string processes', () => {
    expect(parseGameEntry({ id: 'x', name: 'X', processes: [], cmdlinePatterns: [''] })).toBeNull();
    expect(parseGameEntry({ id: 'x', name: 'X', processes: ['ok', 5] })).toBeNull();
  });

  it('defaults type to playing and keeps valid types', () => {
    expect(parseGameEntry({ id: 'x', name: 'X', processes: ['a'] })?.type).toBe('playing');
    expect(parseGameEntry({ id: 'x', name: 'X', processes: ['a'], type: 'watching' })?.type).toBe('watching');
    expect(parseGameEntry({ id: 'x', name: 'X', processes: ['a'], type: 'bogus' })?.type).toBe('playing');
  });
});

describe('validateDictionaryObject', () => {
  it('accepts the versioned format', () => {
    const v = validateDictionaryObject({ version: 7, games: [{ id: 'a', name: 'A', processes: ['a'] }] });
    expect(v?.version).toBe(7);
    expect(v?.entries).toHaveLength(1);
  });

  it('accepts the legacy bare array as version 0', () => {
    const v = validateDictionaryObject([{ id: 'a', name: 'A', processes: ['a'] }]);
    expect(v?.version).toBe(0);
  });

  it('rejects empty or malformed dictionaries', () => {
    expect(validateDictionaryObject({ version: 1, games: [] })).toBeNull();
    expect(validateDictionaryObject({ version: 1 })).toBeNull();
    expect(validateDictionaryObject('nope')).toBeNull();
    expect(validateDictionaryObject([{ id: 'a', name: 'A', processes: [] }])).toBeNull();
  });
});

describe('loadBestDictionary', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dict-test-'));
  const write = (p: string, content: string) => fs.writeFileSync(p, content);

  it('prefers a newer seed and promotes it into the cache', () => {
    const dir = tmp();
    const cache = path.join(dir, 'cache.json');
    const seed = path.join(dir, 'seed.json');
    write(cache, JSON.stringify({ version: 1, games: [{ id: 'old', name: 'Old', processes: ['old'] }] }));
    write(seed, JSON.stringify({ version: 2, games: [{ id: 'new', name: 'New', processes: ['new'] }] }));

    const best = loadBestDictionary(cache, seed);
    expect(best?.version).toBe(2);
    expect(best?.entries[0]?.id).toBe('new');
    // Promotion: cache now holds the seed content
    expect(loadDictionaryFile(cache)?.version).toBe(2);
  });

  it('keeps a newer cache over an older seed', () => {
    const dir = tmp();
    const cache = path.join(dir, 'cache.json');
    const seed = path.join(dir, 'seed.json');
    write(cache, JSON.stringify({ version: 5, games: [{ id: 'cached', name: 'Cached', processes: ['c'] }] }));
    write(seed, JSON.stringify({ version: 2, games: [{ id: 'seeded', name: 'Seeded', processes: ['s'] }] }));

    const best = loadBestDictionary(cache, seed);
    expect(best?.version).toBe(5);
    expect(best?.entries[0]?.id).toBe('cached');
    // Seed must not clobber the newer cache
    expect(loadDictionaryFile(cache)?.entries[0]?.id).toBe('cached');
  });

  it('falls back to the seed when the cache is corrupt', () => {
    const dir = tmp();
    const cache = path.join(dir, 'cache.json');
    const seed = path.join(dir, 'seed.json');
    write(cache, '{ this is not json');
    write(seed, JSON.stringify({ version: 3, games: [{ id: 'seed', name: 'Seed', processes: ['s'] }] }));

    const best = loadBestDictionary(cache, seed);
    expect(best?.version).toBe(3);
  });

  it('returns null when both sources are unusable', () => {
    const dir = tmp();
    expect(loadBestDictionary(path.join(dir, 'missing-a'), path.join(dir, 'missing-b'))).toBeNull();
  });
});

// ─── Scan layer stability ───────────────────────────────────────────────────

describe('nextScanActivity', () => {
  const game = { id: 'osu', name: 'osu!', type: 'playing' };

  it('starts the clock when a game is first seen', () => {
    expect(nextScanActivity(game, null, 1000)).toEqual({ type: 'playing', name: 'osu!', timestamps: { start: 1000 } });
  });

  it('keeps the same activity object while the game keeps running', () => {
    const first = nextScanActivity(game, null, 1000);
    expect(nextScanActivity(game, first, 16_000)).toBe(first);
  });

  it('restarts the clock when a different game takes over', () => {
    const first = nextScanActivity(game, null, 1000);
    const next = nextScanActivity({ id: 'mpv', name: 'mpv', type: 'watching' }, first, 16_000);
    expect(next).toEqual({ type: 'watching', name: 'mpv', timestamps: { start: 16_000 } });
  });

  it('clears when nothing matches', () => {
    expect(nextScanActivity(null, nextScanActivity(game, null, 1000), 2000)).toBeNull();
  });
});

// ─── IPC overlay over process detection ────────────────────────────────────

describe('IPC activity overlay', () => {
  const emitted: Array<{ name?: string; details?: string } | null> = [];

  // One shared detection session: loads the real seed dictionary and
  // registers the emit callback. The poll interval never fires mid-test.
  beforeAll(() => {
    startActivityDetection((activity) => emitted.push(activity));
  });
  afterAll(() => {
    stopActivityDetection();
  });
  afterEach(() => {
    applyIpcActivity(null);
    __testSetScanActivity(null);
  });

  const push = (over: Partial<IpcActivityPush> = {}) =>
    applyIpcActivity({
      clientId: '1216669957799018608',
      pid: null,
      activity: { type: 'playing', details: 'Idle', state: 'In menu' },
      ...over,
    });

  it('overlays an IPC push over the scan-detected game immediately', () => {
    __testSetScanActivity({ type: 'playing', name: 'osu!', timestamps: { start: 1 } });
    const before = emitted.length;
    push({ activity: { type: 'playing', details: 'Playing [Big Black]', state: 'by Blue Stahli' } });
    expect(emitted.length).toBe(before + 1);
    expect(getCurrentActivity()).toMatchObject({ type: 'playing', details: 'Playing [Big Black]' });
  });

  it('falls back to the scan game when the push clears', () => {
    __testSetScanActivity({ type: 'playing', name: 'osu!', timestamps: { start: 1 } });
    push();
    applyIpcActivity(null);
    expect(getCurrentActivity()).toMatchObject({ name: 'osu!' });
  });

  it('emits null when the overlay clears and no scan game remains', () => {
    push();
    applyIpcActivity(null);
    expect(getCurrentActivity()).toBeNull();
  });

  it('emits only when the effective activity changed', () => {
    __testSetScanActivity({ type: 'playing', name: 'osu!' });
    const before = emitted.length;
    // Re-setting an identical scan activity must not re-emit
    __testSetScanActivity({ type: 'playing', name: 'osu!' });
    expect(emitted.length).toBe(before);
  });

  it('shows a map switch immediately, not on the next poll', () => {
    push({ activity: { type: 'playing', details: 'map A' } });
    const before = emitted.length;
    push({ activity: { type: 'playing', details: 'map B' } });
    expect(emitted.length).toBe(before + 1);
    expect(getCurrentActivity()).toMatchObject({ details: 'map B' });
  });

  it('names unnamed pushes through the known-client map', () => {
    push({ activity: { type: 'playing', details: 'Idle' }, pid: null, clientId: '1216669957799018608' });
    expect(getCurrentActivity()).toMatchObject({ name: 'osu!lazer', details: 'Idle' });
  });

  it('keeps the push-provided name when present', () => {
    push({ activity: { type: 'playing', name: 'Custom Name' } as IpcActivityPayload });
    expect(getCurrentActivity()).toMatchObject({ name: 'Custom Name' });
  });

  it('passes art and timestamps through to the Activity', () => {
    push({
      activity: {
        type: 'playing',
        timestamps: { start: 1700000000, end: 1700000300 },
        assets: {
          largeImage: 'https://cdn.discordapp.com/app-assets/1216669957799018608/osu_logo_lazer.png',
          largeText: 'osu!',
          smallImage: 'https://example.com/rank.png',
          smallText: 'SS',
        },
      },
    });
    const a = getCurrentActivity();
    expect(a?.timestamps).toEqual({ start: 1700000000, end: 1700000300 });
    expect(a?.assets?.largeImage).toContain('osu_logo_lazer.png');
    expect(a?.assets?.smallText).toBe('SS');
  });

  it('resolves game names for a pid through the dictionary', () => {
    const root = makeFakeProc([
      {
        pid: 42,
        exe: '/usr/lib/jvm/java-21/bin/java',
        cmdline: ['/usr/bin/java', '-Xmx2G', 'net.minecraft.client.main.Main'],
        comm: 'java',
      },
    ]);
    expect(resolveIpcGameName(42, root)).toBe('Minecraft');
    expect(resolveIpcGameName(null, root)).toBeNull();
    expect(resolveIpcGameName(999, root)).toBeNull();
  });

  it('reports a scan game exit that happened under an active overlay', () => {
    __testSetScanActivity({ type: 'playing', name: 'Minecraft' });
    push({ activity: { type: 'playing', details: 'deep in a map' } });
    // Game exits while the overlay is live
    __testSetScanActivity(null);
    expect(getCurrentActivity()).toMatchObject({ details: 'deep in a map' });
    // Overlay clears afterwards — nothing is left
    applyIpcActivity(null);
    expect(getCurrentActivity()).toBeNull();
  });
});

describe('Steam source detector', () => {
  const games = [{ appId: 1245620, name: 'ELDEN RING', installDir: '/lib/steamapps/common/ELDEN RING' }];
  const steam = createSteamSourceDetector(() => games);
  const RUNTIME = '/lib/steamapps/common/SteamLinuxRuntime_sniper';
  const LAUNCH = `/s/ubuntu12_32/reaper SteamLaunch AppId=1245620 -- ${RUNTIME}/_v2-entry-point --verb=waitforexitandrun -- /lib/steamapps/common/Proton 9.0/proton waitforexitandrun /lib/steamapps/common/ELDEN RING/Game/eldenring.exe`;

  it('names a Proton game from its reaper even when runtime processes come first', () => {
    const infos = [
      { pid: 1, name: 'bwrap', cmdline: 'bwrap --unshare-pid', exe: `${RUNTIME}/pressure-vessel/bin/bwrap` },
      { pid: 2, name: 'wine64-preloader', cmdline: 'wine64-preloader eldenring.exe', exe: '/lib/steamapps/common/Proton 9.0/files/bin/wine64-preloader' },
      { pid: 3, name: 'reaper', cmdline: LAUNCH, exe: '/s/ubuntu12_32/reaper' },
    ];
    expect(detectActivity(infos, [], [steam])).toEqual({ id: 'steam-1245620', name: 'ELDEN RING', type: 'playing' });
  });

  it('shows nothing for Steam alone, with its runtime processes running', () => {
    const infos = [
      { pid: 1, name: 'steam', cmdline: '/usr/bin/steam', exe: '/usr/lib/steam/bin_steam.sh' },
      { pid: 2, name: 'srt-logger', cmdline: 'srt-logger', exe: `${RUNTIME}/pressure-vessel/libexec/srt-logger` },
    ];
    expect(detectActivity(infos, [], [steam])).toBeNull();
  });

  it('still matches a native game by the directory its executable lives in', () => {
    const infos = [{ pid: 1, name: 'game', cmdline: 'game', exe: '/lib/steamapps/common/ELDEN RING/game' }];
    expect(detectActivity(infos, [], [steam])?.id).toBe('steam-1245620');
  });
});

describe('Wine processes', () => {
  const dict = [
    { id: 'honkai-sr', name: 'Honkai: Star Rail', processes: ['StarRail.exe'] },
    { id: 'stardew', name: 'Stardew Valley', processes: ['Stardew Valley.exe', 'StardewValley'] },
  ];
  const PRELOADER = '/home/u/.var/app/com.usebottles.bottles/data/bottles/runners/soda-9.0/bin/wine64-preloader';

  it('names the program from its Windows command line, not the loader', () => {
    const root = makeFakeProc([
      { pid: 5, exe: PRELOADER, cmdline: ['Z:\\home\\u\\Games\\HSR\\StarRail.exe'], comm: 'StarRail.exe' },
    ]);
    const info = readProcessInfos(root)[0]!;
    expect(info.name).toBe('wine64-preloader');
    expect(info.winExes).toContain('StarRail.exe');
    expect(findMatchingGame([info], dict)?.id).toBe('honkai-sr');
  });

  it('keeps the working directory of a Wine process, and only of one', () => {
    const root = makeFakeProc([
      { pid: 5, exe: PRELOADER, cmdline: ['Z:\\g\\StarRail.exe'], comm: 'StarRail.exe', cwd: '/home/u/Games/HSR' },
      { pid: 6, exe: '/usr/bin/bash', cmdline: ['bash'], comm: 'bash', cwd: '/home/u' },
    ]);
    const infos = readProcessInfos(root);
    expect(infos.find((i) => i.pid === 5)?.cwd).toBe('/home/u/Games/HSR');
    expect(infos.find((i) => i.pid === 6)?.cwd).toBeUndefined();
    expect(readProcessInfoByPid(5, root)?.cwd).toBe('/home/u/Games/HSR');
  });

  it('reads a program name with spaces and arguments out of one command line token', () => {
    expect(deriveWindowsExes(PRELOADER, ['C:\\Program Files\\Stardew Valley\\Stardew Valley.exe -console'], null))
      .toContain('Stardew Valley.exe');
  });

  it('falls back to the kernel-truncated comm, which still matches a longer dictionary name', () => {
    const root = makeFakeProc([{ pid: 6, exe: PRELOADER, comm: 'Stardew Valley.' }]);
    const info = readProcessInfos(root)[0]!;
    expect(info.winExes).toEqual(['Stardew Valley.']);
    expect(findMatchingGame([info], dict)?.id).toBe('stardew');
  });

  it('works when the exe link is unreadable (a sandboxed process) but the command line is Windows-style', () => {
    const root = makeFakeProc([{ pid: 8, exe: 'REGULAR', cmdline: ['Z:\\g\\StarRail.exe'], comm: 'StarRail.exe' }]);
    const info = readProcessInfos(root)[0]!;
    expect(info.name).toBe('StarRail.exe');
    expect(findMatchingGame([info], dict)?.id).toBe('honkai-sr');
  });

  it('finds the program on the `wine game.exe` launcher process too', () => {
    expect(deriveWindowsExes('/usr/bin/wine', ['wine', '/games/StarRail.exe'], 'wine')).toEqual(['StarRail.exe']);
  });

  it('does not take a native program for a Wine one because an argument ends in .exe', () => {
    expect(deriveWindowsExes('/usr/bin/vim', ['vim', 'StarRail.exe'], 'vim')).toBeUndefined();
    const root = makeFakeProc([{ pid: 9, exe: '/usr/bin/vim', cmdline: ['vim', 'StarRail.exe'], comm: 'vim' }]);
    expect(findMatchingGame(readProcessInfos(root), dict)).toBeNull();
  });

  it('ignores wineserver and the loader of an unrelated program', () => {
    expect(deriveWindowsExes('/opt/wine/bin/wineserver', ['wineserver', '-p'], 'wineserver')).toBeUndefined();
    expect(deriveWindowsExes(PRELOADER, ['C:\\windows\\system32\\services.exe'], 'services.exe')).toBeUndefined();
    const root = makeFakeProc([{ pid: 10, exe: PRELOADER, cmdline: ['C:\\windows\\system32\\services.exe'], comm: 'services.exe' }]);
    expect(findMatchingGame(readProcessInfos(root), dict)).toBeNull();
  });
});

describe('the shipped dictionary under Wine', () => {
  const seed = loadDictionaryFile(path.join(__dirname, '..', 'resources', 'games.json'));
  const PRELOADER = '/home/u/.local/share/lutris/runners/wine/lutris-9.0/bin/wine64-preloader';

  it.each([
    ['Honkai: Star Rail', 'StarRail.exe'],
    ['Zenless Zone Zero', 'ZenlessZoneZero.exe'],
    ['Genshin Impact', 'GenshinImpact.exe'],
    ['Stardew Valley', 'Stardew Valley.exe'],
  ])('finds %s from its Wine process', (name, exe) => {
    const root = makeFakeProc([{ pid: 3, exe: PRELOADER, cmdline: [`Z:\\games\\${exe}`], comm: exe.slice(0, 15) }]);
    const match = findMatchingGame(readProcessInfos(root), seed?.entries ?? []);
    expect(match?.name).toBe(name);
  });
});

describe('Wine processes as they really look', () => {
  const dict = [
    { id: 'zzz', name: 'Zenless Zone Zero', processes: ['ZenlessZoneZero.exe'] },
    { id: 'stardew', name: 'Stardew Valley', processes: ['Stardew Valley.exe', 'StardewValley'] },
    { id: 'steam', name: 'Steam', processes: ['steam.exe'] },
  ];
  const LOADER = '/mnt/hd_G/Games/ZZZ/runners/spritz-wine/bin/wine64-preloader';

  it("finds Zenless Zone Zero from Proton's steam.exe shim, which names the game as its argument", () => {
    const root = makeFakeProc([
      { pid: 1, exe: LOADER, cmdline: ['steam.exe', 'ZenlessZoneZero.exe', '-window-mode', 'exclusive'], comm: 'steam.exe' },
    ]);
    const info = readProcessInfos(root)[0]!;
    expect(info.winExes).toEqual(['ZenlessZoneZero.exe']);
    expect(findMatchingGame([info], dict)?.id).toBe('zzz');
  });

  it('finds the game itself from a bare program name, and its comm', () => {
    const root = makeFakeProc([
      { pid: 2, exe: LOADER, cmdline: ['ZenlessZoneZero.exe', '-window-mode', 'exclusive'], comm: 'ZenlessZoneZero' },
    ]);
    const info = readProcessInfos(root)[0]!;
    expect(info.winExes).toEqual(['ZenlessZoneZero.exe', 'ZenlessZoneZero']);
    expect(findMatchingGame([info], dict)?.id).toBe('zzz');
  });

  it('finds Stardew Valley whether its Windows path arrives as one argv token or several', () => {
    for (const cmdline of [
      ['C:\\GOG Games\\Stardew Valley\\Stardew Valley.exe'],
      ['C:\\GOG', 'Games\\Stardew', 'Valley\\Stardew', 'Valley.exe'],
    ]) {
      const root = makeFakeProc([{ pid: 3, exe: LOADER, cmdline, comm: 'Stardew Valley.' }]);
      const info = readProcessInfos(root)[0]!;
      expect(findMatchingGame([info], dict)?.id).toBe('stardew');
    }
  });

  it("finds Stardew Valley on the `start.exe /wait` wrapper that outlives the launch, and nothing else a prefix runs", () => {
    const wrapper = ['C:\\windows\\system32\\start.exe', '/wait', '/d', 'C:\\GOG Games\\Stardew Valley', 'C:\\GOG Games\\Stardew Valley\\Stardew Valley.exe'];
    expect(deriveWindowsExes(LOADER, wrapper, 'start.exe')).toContain('Stardew Valley.exe');
    for (const [args, comm] of [
      [['C:\\windows\\system32\\services.exe'], 'services.exe'],
      [['C:\\windows\\system32\\svchost.exe', '-k', 'netsvcs'], 'svchost.exe'],
      [['C:\\windows\\system32\\explorer.exe', '/desktop'], 'explorer.exe'],
      [['G:\\UnityCrashHandler64.exe', '--attach', '276'], 'UnityCrashHandl'],
      [['C:\\Program Files (x86)\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe', '/c'], 'MicrosoftEdgeUp'],
    ] as Array<[string[], string]>) {
      expect(deriveWindowsExes(LOADER, args, comm)).toBeUndefined();
    }
  });

  it('keeps the shim as the program only when it names nothing else', () => {
    expect(deriveWindowsExes(LOADER, ['steam.exe'], 'steam.exe')).toEqual(['steam.exe']);
    expect(deriveWindowsExes(LOADER, ['steam.exe', 'Game.exe'], 'steam.exe')).toEqual(['Game.exe']);
  });
});

describe('several games at once', () => {
  const dict = [
    { id: 'hsr', name: 'Honkai: Star Rail', processes: ['StarRail.exe'] },
    { id: 'stardew', name: 'Stardew Valley', processes: ['Stardew Valley.exe'] },
    { id: 'minecraft-launcher', name: 'Minecraft Launcher', processes: ['minecraft-launcher'] },
    { id: 'mpv', name: 'mpv', processes: ['mpv'], type: 'watching' },
  ];
  const proc = (pid: number, name: string, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({ pid, name, cmdline: name, exe: null, ...extra });

  it('lists every running game, in dictionary order', () => {
    const games = detectActivitiesWithInfo([proc(1, 'Stardew Valley.exe'), proc(2, 'StarRail.exe')], dict, []);
    expect(games.map((g) => g.matched.name)).toEqual(['Honkai: Star Rail', 'Stardew Valley']);
    expect(games[0]?.info?.pid).toBe(2);
  });

  it('lists a game once however many processes it has', () => {
    const games = detectActivitiesWithInfo([proc(1, 'StarRail.exe'), proc(2, 'StarRail.exe')], dict, []);
    expect(games).toHaveLength(1);
  });

  it('hides a launcher while a game runs, and shows it alone', () => {
    const both = detectActivitiesWithInfo([proc(1, 'minecraft-launcher'), proc(2, 'StarRail.exe')], dict, []);
    expect(both.map((g) => g.matched.id)).toEqual(['hsr']);
    const alone = detectActivitiesWithInfo([proc(1, 'minecraft-launcher')], dict, []);
    expect(alone.map((g) => g.matched.id)).toEqual(['minecraft-launcher']);
  });

  it('keeps a video player next to a game and does not let it hide a launcher', () => {
    const games = detectActivitiesWithInfo([proc(1, 'mpv'), proc(2, 'minecraft-launcher')], dict, []);
    expect(games.map((g) => g.matched.id).sort()).toEqual(['minecraft-launcher', 'mpv']);
  });

  it('adds source-detected games after the dictionary ones, without repeating a claimed process or name', () => {
    const source: SourceDetector = (info) => {
      if (info.name === 'steamgame') return { id: 'steam-1', name: 'Steam Only', type: 'playing' };
      if (info.name === 'StarRail.exe') return { id: 'steam-2', name: 'Honkai Star Rail', type: 'playing' };
      if (info.name === 'reaper') return { id: 'steam-3', name: 'honkai: star rail', type: 'playing' };
      return null;
    };
    const games = detectActivitiesWithInfo(
      [proc(1, 'steamgame'), proc(2, 'StarRail.exe'), proc(3, 'reaper')],
      dict,
      [source],
    );
    expect(games.map((g) => g.matched.name)).toEqual(['Honkai: Star Rail', 'Steam Only']);
  });

  it('does not let a source rename a process the dictionary already claimed', () => {
    const source: SourceDetector = (info) => (info.name === 'StarRail.exe' ? { id: 'steam-9', name: 'HSR (Steam title)', type: 'playing' } : null);
    const games = detectActivitiesWithInfo([proc(2, 'StarRail.exe')], dict, [source]);
    expect(games.map((g) => g.matched.name)).toEqual(['Honkai: Star Rail']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `g${i}`, name: `Game ${i}`, processes: [`g${i}.exe`] }));
    const infos = many.map((g, i) => proc(i + 1, `g${i}.exe`));
    expect(detectActivitiesWithInfo(infos, many, [])).toHaveLength(MAX_DETECTED_GAMES);
  });

  it('knows a launcher by name or id', () => {
    expect(isLauncherGame({ id: 'x', name: 'Prism Launcher', type: 'playing' })).toBe(true);
    expect(isLauncherGame({ id: 'minecraft-launcher', name: 'Minecraft', type: 'playing' })).toBe(true);
    expect(isLauncherGame({ id: 'hsr', name: 'Honkai: Star Rail', type: 'playing' })).toBe(false);
  });
});

describe('scan layer and IPC with several games', () => {
  const a = { id: 'a', name: 'A', type: 'playing' };
  const b = { id: 'b', name: 'B', type: 'playing' };

  it('keeps each running game its own start time', () => {
    const first = nextScanActivities([a, b], [], 1000);
    const next = nextScanActivities([b, a], first, 16_000);
    expect(next[0]).toBe(first[1]);
    expect(next[1]).toBe(first[0]);
    const third = nextScanActivities([a], next, 31_000);
    expect(third[0]).toBe(first[0]);
  });

  it('lets a push stand in for the scanned game of the same name, in place', () => {
    const scan = nextScanActivities([a, b], [], 1);
    const push = { type: 'playing', name: 'b', details: 'map' };
    const merged = mergeActivities(scan, push);
    expect(merged.map((x) => x.name)).toEqual(['A', 'b']);
    expect(merged[1]).toBe(push);
  });

  it('puts a push for an unscanned game first and keeps the scanned ones', () => {
    const scan = nextScanActivities([a], [], 1);
    const merged = mergeActivities(scan, { type: 'playing', name: 'osu!lazer' });
    expect(merged.map((x) => x.name)).toEqual(['osu!lazer', 'A']);
  });

  it('never exceeds the cap', () => {
    const scan = Array.from({ length: 5 }, (_, i) => ({ type: 'playing', name: `G${i}` }));
    expect(mergeActivities(scan, { type: 'playing', name: 'new' })).toHaveLength(MAX_DETECTED_GAMES);
  });

  describe('emitted changes', () => {
    const lists: Array<Array<{ name: string }>> = [];
    const singles: Array<{ name: string } | null> = [];
    beforeAll(() => {
      startActivityDetection((x) => singles.push(x), (x) => lists.push(x));
    });
    afterAll(() => stopActivityDetection());
    afterEach(() => {
      applyIpcActivity(null);
      __testSetScanActivities([]);
      lists.length = 0;
      singles.length = 0;
    });

    it('sends the list on every change and the single activity only when the first changes', () => {
      __testSetScanActivities([{ type: 'playing', name: 'A' }]);
      __testSetScanActivities([{ type: 'playing', name: 'A' }, { type: 'playing', name: 'B' }]);
      expect(lists.map((l) => l.map((x) => x.name))).toEqual([['A'], ['A', 'B']]);
      expect(singles.map((x) => x?.name)).toEqual(['A']);
      expect(getCurrentActivity()).toMatchObject({ name: 'A' });
      expect(getCurrentActivities().map((x) => x.name)).toEqual(['A', 'B']);
    });

    it('does not repeat an unchanged list', () => {
      __testSetScanActivities([{ type: 'playing', name: 'A' }]);
      __testSetScanActivities([{ type: 'playing', name: 'A' }]);
      expect(lists).toHaveLength(1);
    });
  });
});

describe('a game tied to a program', () => {
  const dict = [{ id: 'stardew', name: 'Stardew Valley', processes: ['Stardew Valley.exe'] }];
  const proc = (pid: number, name: string, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({ pid, name, cmdline: name, exe: null, ...extra });

  it('is shown while its program runs, under the player\'s name, and not otherwise', () => {
    const binding = { name: 'My Game', process: 'mygame' };
    expect(detectActivitiesWithInfo([proc(1, 'MyGame')], dict, [], 5, binding).map((g) => g.matched.name)).toEqual(['My Game']);
    expect(detectActivitiesWithInfo([proc(1, 'bash')], dict, [], 5, binding)).toEqual([]);
  });

  it('follows a Wine program by its Windows name', () => {
    const wine = proc(4, 'wine64-preloader', { winExes: ['Weird.exe'] });
    const games = detectActivitiesWithInfo([wine], dict, [], 5, { name: 'Weird', process: 'weird.exe' });
    expect(games[0]?.info?.pid).toBe(4);
  });

  it('replaces the automatic entry for the same process instead of listing the game twice', () => {
    const games = detectActivitiesWithInfo(
      [proc(1, 'Stardew Valley.exe')],
      dict,
      [],
      5,
      { name: 'Farm', process: 'Stardew Valley.exe' },
    );
    expect(games.map((g) => g.matched.name)).toEqual(['Farm']);
  });

  it('keeps other games next to it, the tied one first', () => {
    const games = detectActivitiesWithInfo(
      [proc(1, 'Stardew Valley.exe'), proc(2, 'MyGame')],
      dict,
      [],
      5,
      { name: 'Mine', process: 'MyGame' },
    );
    expect(games.map((g) => g.matched.name)).toEqual(['Mine', 'Stardew Valley']);
  });

  it('ties several games at once, each first-listed in the order given', () => {
    const bindings = [{ name: 'One', process: 'one' }, { name: 'Two', process: 'two.exe' }];
    const wine = proc(7, 'wine64-preloader', { winExes: ['Two.exe'] });
    const games = detectActivitiesWithInfo([proc(1, 'one'), wine, proc(2, 'Stardew Valley.exe')], dict, [], 5, bindings);
    expect(games.map((g) => g.matched.name)).toEqual(['One', 'Two', 'Stardew Valley']);
    expect(new Set(games.map((g) => g.matched.id)).size).toBe(3);
  });

  it('takes a list through the setter, ignoring junk and repeats', () => {
    setManualBindings([{ name: 'A', process: 'a' }, { name: 'A again', process: 'A' }, 5, null, { name: '', process: 'x' }]);
    expect(getManualBindings()).toEqual([{ name: 'A', process: 'a' }]);
    setManualBinding({ name: 'Solo', process: 'solo' });
    expect(getManualBindings()).toEqual([{ name: 'Solo', process: 'solo' }]);
    setManualBindings('nope');
    expect(getManualBindings()).toEqual([]);
  });

  it('accepts only a well-formed binding', () => {
    expect(parseManualBinding({ name: ' A ', process: ' b ' })).toEqual({ name: 'A', process: 'b' });
    expect(parseManualBinding(null)).toBeNull();
    expect(parseManualBinding({ name: 'A' })).toBeNull();
    expect(parseManualBinding({ name: '', process: 'b' })).toBeNull();
    expect(parseManualBinding({ name: 'A', process: 'x'.repeat(257) })).toBeNull();
    expect(parseManualBinding({ name: 5, process: 'b' })).toBeNull();
    setManualBinding('junk'); // ignored, clears
  });
});

describe('listRunningPrograms', () => {
  it('offers the player\'s own non-system programs, Wine ones by their Windows name', () => {
    const root = makeFakeProc([
      { pid: 1, exe: '/usr/bin/bash', cmdline: ['bash'], comm: 'bash' },
      { pid: 2, exe: '/home/u/Games/mygame/MyGame', cmdline: ['/home/u/Games/mygame/MyGame'], comm: 'MyGame' },
      { pid: 3, exe: '/home/u/runners/bin/wine64-preloader', cmdline: ['Z:\\g\\Weird Game.exe'], comm: 'Weird Game.ex' },
      { pid: 4, exe: '/home/u/Games/mygame/MyGame', cmdline: ['/home/u/Games/mygame/MyGame'], comm: 'MyGame' },
    ]);
    const programs = listRunningPrograms(root, null);
    expect(programs.map((p) => p.process).sort()).toEqual(['MyGame', 'Weird Game.exe']);
    expect(programs.find((p) => p.process === 'Weird Game.exe')?.label).toBe('Weird Game');
  });

  it('skips processes of other users', () => {
    const root = makeFakeProc([{ pid: 2, exe: '/home/u/g/Game', cmdline: ['Game'], comm: 'Game' }]);
    expect(listRunningPrograms(root, process.getuid!() + 1)).toEqual([]);
    expect(listRunningPrograms(root, process.getuid!())).toHaveLength(1);
  });
});

describe('unknown Wine programs', () => {
  const wine = (pid: number, exe: string, cwd?: string): ProcessInfo => ({ pid, name: 'wine64-preloader', cmdline: exe, exe: '/r/wine64-preloader', winExes: [exe], cwd });
  const game = (info: ProcessInfo) => ({ matched: { id: 'g', name: 'G', type: 'playing' }, info });

  it('lists a Wine program no game claims', () => {
    expect(findUnknownWinePrograms([wine(1, 'Mystery.exe', '/g/m')], [])).toEqual([{ label: 'Mystery', process: 'Mystery.exe' }]);
  });

  it('leaves out a detected game\'s own process and the helpers in its folder', () => {
    const main = wine(1, 'Game.exe', '/g/game');
    const helper = wine(2, 'Helper.exe', '/g/game/bin');
    const other = wine(3, 'Else.exe', '/g/else');
    expect(findUnknownWinePrograms([main, helper, other], [game(main)]).map((p) => p.process)).toEqual(['Else.exe']);
  });

  it('ignores programs without a Windows name and lists each once', () => {
    const native: ProcessInfo = { pid: 4, name: 'bash', cmdline: 'bash', exe: '/usr/bin/bash' };
    expect(findUnknownWinePrograms([native, wine(5, 'A.exe'), wine(6, 'a.EXE')], [])).toHaveLength(1);
  });
});

describe('isObsStreaming', () => {
  let tempDir: string;
  let obsLogDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    process.env.APPDATA = tempDir;
    process.env.XDG_CONFIG_HOME = tempDir;

    // Platform-specific obs log dir
    if (process.platform === 'win32') {
      obsLogDir = path.join(tempDir, 'obs-studio', 'logs');
    } else if (process.platform === 'darwin') {
      obsLogDir = path.join(tempDir, 'Library', 'Application Support', 'obs-studio', 'logs');
    } else {
      obsLogDir = path.join(tempDir, 'obs-studio', 'logs');
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns false when OBS logs directory does not exist', () => {
    expect(isObsStreaming()).toBe(false);
  });

  it('returns false when OBS is open but idle (no stream started)', () => {
    fs.mkdirSync(obsLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(obsLogDir, '2026-10-19 22-00-00.txt'),
      '12:00:00.000: CPU Name: Apple M1\n12:00:00.001: Loaded scenes and sources.\n',
    );
    expect(isObsStreaming()).toBe(false);
  });

  it('returns true when streaming has started', () => {
    fs.mkdirSync(obsLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(obsLogDir, '2026-10-19 22-00-00.txt'),
      '12:00:00.000: CPU Name: Apple M1\n12:01:00.000: ==== Streaming Start ===============================================\n',
    );
    expect(isObsStreaming()).toBe(true);
  });

  it('returns false when streaming was started and then stopped', () => {
    fs.mkdirSync(obsLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(obsLogDir, '2026-10-19 22-00-00.txt'),
      '12:00:00.000: CPU Name: Apple M1\n12:01:00.000: ==== Streaming Start ===============================================\n12:30:00.000: ==== Streaming Stop ================================================\n',
    );
    expect(isObsStreaming()).toBe(false);
  });

  it('returns true when streaming was stopped and then started again in same session', () => {
    fs.mkdirSync(obsLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(obsLogDir, '2026-10-19 22-00-00.txt'),
      '12:01:00.000: ==== Streaming Start ===============================================\n12:30:00.000: ==== Streaming Stop ================================================\n12:35:00.000: ==== Streaming Start ===============================================\n',
    );
    expect(isObsStreaming()).toBe(true);
  });
});

