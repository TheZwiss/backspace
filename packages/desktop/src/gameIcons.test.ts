import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findGameIcon,
  getGameIcon,
  resolveGameIcon,
  warmGameIcon,
  warmGameIconForIpc,
  sniffImageMime,
  parseDesktopEntry,
  execProgramName,
  __testResetGameIconCache,
  type GameIconTarget,
} from './gameIcons';
import { encodePng } from './peIcon';
import { buildPe } from './peIcon.testSupport';

// Minimal images: the extractor only sniffs magic bytes; the server is the
// party that decodes and re-encodes.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('rest-of-a-png'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest-of-a-jpg')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), Buffer.from('VP8 data')]);
const NOT_AN_IMAGE = Buffer.from('just text, no image magic at all');

let home: string;

function write(file: string, bytes: Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function target(overrides: Partial<GameIconTarget> = {}): GameIconTarget {
  return { id: 'some-game', name: 'Some Game', exe: null, cmdline: '', ...overrides };
}

beforeEach(() => {
  __testResetGameIconCache();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'game-icons-test-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('sniffImageMime', () => {
  it('recognizes the three accepted formats and nothing else', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
    expect(sniffImageMime(NOT_AN_IMAGE)).toBeNull();
    expect(sniffImageMime(Buffer.alloc(4))).toBeNull();
  });
});

describe('parseDesktopEntry', () => {
  it('reads Exec, Name and Icon from the desktop section only', () => {
    const entry = parseDesktopEntry([
      '[Desktop Entry]',
      'Type=Application',
      'Name=My Game',
      'Exec=/opt/mygame/run.sh --flag',
      'Icon=mygame',
      '',
      '[Desktop Action Play]',
      'Icon=should-not-win',
    ].join('\n'));
    expect(entry).toEqual({ exec: '/opt/mygame/run.sh --flag', name: 'My Game', icon: 'mygame' });
  });

  it('returns null without an Icon', () => {
    expect(parseDesktopEntry('[Desktop Entry]\nName=x\nExec=y\n')).toBeNull();
  });
});

describe('findGameIcon', () => {
  it('reads the Steam library cache by app id', async () => {
    write(path.join(home, '.local', 'share', 'Steam', 'appcache', 'librarycache', '1234_icon.jpg'), JPEG);
    const icon = await findGameIcon(target({ id: 'steam-1234' }), home);
    expect(icon?.mime).toBe('image/jpeg');
  });

  it('falls back to Steam cover art when the grid icon is missing', async () => {
    write(path.join(home, '.local', 'share', 'Steam', 'appcache', 'librarycache', '1234', 'library_600x900.jpg'), JPEG);
    const icon = await findGameIcon(target({ id: 'steam-1234' }), home);
    expect(icon?.mime).toBe('image/jpeg');
  });

  it('reads a GOG install directory icon', async () => {
    const gameDir = path.join(home, 'GOG Games', 'Beneath A Steel Sky');
    write(path.join(gameDir, 'goggame-1207658924.info'), Buffer.from('{"name":"Beneath A Steel Sky","gameId":"1207658924"}'));
    write(path.join(gameDir, 'support', 'icon.png'), PNG);
    const icon = await findGameIcon(target({ id: 'gog-1207658924' }), home);
    expect(icon?.mime).toBe('image/png');
  });

  it('finds the .DirIcon at an AppImage mount root, two levels above the binary', async () => {
    // osu!lazer's AppImage mounts with the binary at <mount>/usr/bin/osu!
    const mount = path.join(home, '.mount_osuABCD');
    write(path.join(mount, 'usr', 'bin', 'osu!'), Buffer.from('elf binary'));
    write(path.join(mount, '.DirIcon'), PNG);
    const icon = await findGameIcon(target({ name: 'osu!', exe: path.join(mount, 'usr', 'bin', 'osu!') }), home);
    expect(icon?.mime).toBe('image/png');
  });

  it('resolves a .desktop entry by executable and looks its icon up in hicolor', async () => {
    write(path.join(home, '.local', 'share', 'applications', 'mygame.desktop'), Buffer.from([
      '[Desktop Entry]',
      'Type=Application',
      'Name=My Game',
      'Exec=/opt/mygame/bin/mygame',
      'Icon=mygame',
    ].join('\n')));
    write(path.join(home, '.local', 'share', 'icons', 'hicolor', '128x128', 'apps', 'mygame.png'), PNG);
    const icon = await findGameIcon(target({ name: 'My Game', exe: '/opt/mygame/bin/mygame' }), home);
    expect(icon?.mime).toBe('image/png');
  });

  it('matches a .desktop entry by display name and takes its absolute icon path', async () => {
    const iconFile = write(path.join(home, 'named-game', 'icon.png'), PNG);
    write(path.join(home, '.local', 'share', 'applications', 'named.desktop'), Buffer.from([
      '[Desktop Entry]',
      'Type=Application',
      'Name=My Game',
      'Exec=/somewhere/bin/mygame',
      `Icon=${iconFile}`,
    ].join('\n')));
    const icon = await findGameIcon(target({ name: 'my game' }), home);
    expect(icon?.mime).toBe('image/png');
  });

  it('never takes an icon from the game executable itself', async () => {
    // An executable that happens to start with image magic bytes is still a binary
    const exe = write(path.join(home, 'game', 'bin', 'game'), PNG);
    expect(await findGameIcon(target({ name: 'Some Game', exe }), home)).toBeNull();
  });

  it('reads no file larger than the limit, and never reads one to find out', async () => {
    const mount = path.join(home, 'mount');
    const exe = write(path.join(mount, 'usr', 'bin', 'game'), Buffer.from('elf'));
    const big = path.join(mount, '.DirIcon');
    fs.writeFileSync(big, Buffer.alloc(0));
    fs.truncateSync(big, 600 * 1024); // sparse, over the 512 KiB limit
    fs.writeFileSync(path.join(mount, 'icon.png'), PNG);
    const reads: string[] = [];
    const original = fs.promises.readFile;
    fs.promises.readFile = ((...args: Parameters<typeof original>) => {
      reads.push(String(args[0]));
      return original(...args);
    }) as typeof original;
    try {
      const icon = await findGameIcon(target({ exe }), home);
      // The oversized .DirIcon is skipped without being read; the next candidate wins
      expect(icon?.bytes.equals(PNG)).toBe(true);
    } finally {
      fs.promises.readFile = original;
    }
    expect(reads).toEqual([]);
  });

  it('ignores a candidate that is not a regular file', async () => {
    const mount = path.join(home, 'mount2');
    const exe = write(path.join(mount, 'usr', 'bin', 'game'), Buffer.from('elf'));
    fs.mkdirSync(path.join(mount, '.DirIcon'));
    expect(await findGameIcon(target({ exe }), home)).toBeNull();
  });

  it('does not hand a java game the icon of another java program', async () => {
    const iconFile = write(path.join(home, 'jd', 'icon.png'), PNG);
    write(path.join(home, '.local', 'share', 'applications', 'jdownloader.desktop'), Buffer.from([
      '[Desktop Entry]',
      'Name=JDownloader 2',
      'Exec=java -jar /opt/jd/JDownloader.jar',
      `Icon=${iconFile}`,
    ].join('\n')));
    expect(await findGameIcon(target({ name: 'Minecraft', exe: '/usr/lib/jvm/java-21/bin/java' }), home)).toBeNull();
  });

  it('still matches a host-run game by its display name', async () => {
    const iconFile = write(path.join(home, 'mc', 'icon.png'), PNG);
    write(path.join(home, '.local', 'share', 'applications', 'mc.desktop'), Buffer.from([
      '[Desktop Entry]',
      'Name=Minecraft',
      'Exec=java -jar /opt/mc/launcher.jar',
      `Icon=${iconFile}`,
    ].join('\n')));
    const icon = await findGameIcon(target({ name: 'Minecraft', exe: '/usr/lib/jvm/java-21/bin/java' }), home);
    expect(icon?.mime).toBe('image/png');
  });

  it('does not match a program whose name merely contains the executable name', async () => {
    const iconFile = write(path.join(home, 'x', 'icon.png'), PNG);
    write(path.join(home, '.local', 'share', 'applications', 'other.desktop'), Buffer.from([
      '[Desktop Entry]',
      'Name=Other App',
      'Exec=/opt/other/mygame-editor',
      `Icon=${iconFile}`,
    ].join('\n')));
    expect(await findGameIcon(target({ name: 'My Game', exe: '/opt/mygame/bin/mygame' }), home)).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    expect(await findGameIcon(target({ name: 'Nothing' }), home)).toBeNull();
  });

  it('skips files that are not accepted images', async () => {
    write(path.join(home, '.local', 'share', 'Steam', 'appcache', 'librarycache', '1234_icon.jpg'), NOT_AN_IMAGE);
    expect(await findGameIcon(target({ id: 'steam-1234' }), home)).toBeNull();
  });
});

function installSteamGame(appId: number, name: string): void {
  const steam = path.join(home, '.local', 'share', 'Steam');
  write(
    path.join(steam, 'steamapps', `appmanifest_${appId}.acf`),
    Buffer.from(`"AppState"\n{\n\t"appid"\t\t"${appId}"\n\t"name"\t\t"${name}"\n\t"installdir"\t\t"${name}"\n\t"StateFlags"\t\t"4"\n}\n`),
  );
  write(path.join(steam, 'appcache', 'librarycache', `${appId}_icon.jpg`), JPEG);
}

describe('installed games the dictionary or the player named', () => {
  it('gives a dictionary-matched game its Steam icon by the installed name', async () => {
    installSteamGame(1245620, 'ELDEN RING');
    // The dictionary's key says nothing about a store
    const icon = await findGameIcon(target({ id: 'elden-ring', name: 'Elden Ring' }), home);
    expect(icon?.mime).toBe('image/jpeg');
  });

  it('gives it the Steam icon by the running executable', async () => {
    installSteamGame(70, 'Half-Life');
    const exe = path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common', 'Half-Life', 'hl.sh');
    write(exe, Buffer.from('#!/bin/sh'));
    const icon = await findGameIcon(target({ id: 'half-life', name: 'HL', exe }), home);
    expect(icon?.mime).toBe('image/jpeg');
  });

  it('finds nothing for a name no store knows', async () => {
    installSteamGame(1245620, 'ELDEN RING');
    expect(await findGameIcon(target({ id: '', name: 'Another Game' }), home)).toBeNull();
  });
});

describe('resolveGameIcon', () => {
  it('looks a name up that nothing warmed, as a hand-typed game is', async () => {
    installSteamGame(1245620, 'ELDEN RING');
    const original = os.homedir;
    os.homedir = () => home;
    try {
      const icon = await resolveGameIcon('elden ring');
      expect(icon?.mime).toBe('image/jpeg');
    } finally {
      os.homedir = original;
    }
  });

  it('waits for a lookup already in flight instead of answering too early', async () => {
    write(path.join(home, '.local', 'share', 'Steam', 'appcache', 'librarycache', '1234_icon.jpg'), JPEG);
    const warming = warmGameIcon(target({ id: 'steam-1234', name: 'Slow Game' }), home);
    const icon = await resolveGameIcon('Slow Game');
    await warming;
    expect(icon?.mime).toBe('image/jpeg');
  });
});

describe('warm cache', () => {
  it('warms by scan target and serves the icon by game name', async () => {
    write(path.join(home, '.local', 'share', 'Steam', 'appcache', 'librarycache', '1234_icon.jpg'), JPEG);
    await warmGameIcon(target({ id: 'steam-1234', name: 'My Steam Game' }), home);
    expect(getGameIcon('My Steam Game')?.mime).toBe('image/jpeg');
    // Second warm of the same name is a no-op that keeps the cached icon
    await warmGameIcon(target({ id: 'steam-9999', name: 'My Steam Game' }), home);
    expect(getGameIcon('My Steam Game')?.mime).toBe('image/jpeg');
  });

  it('remembers a miss instead of rescanning every poll', async () => {
    await warmGameIcon(target({ name: 'Ghost Game' }), home);
    expect(getGameIcon('Ghost Game')).toBeNull();
  });

  it('warms for an IPC push through the /proc exe of the pushing pid', async () => {
    // This test process's own pid: its exe is a binary with no icons around,
    // proving the /proc path runs and caches the miss without throwing.
    await warmGameIconForIpc('Ghost IPC Game', process.pid, '/proc');
    expect(getGameIcon('Ghost IPC Game')).toBeNull();
  });

  it('tolerates a dead pid', async () => {
    await warmGameIconForIpc('Dead Pid Game', 999_999_999, '/proc');
    expect(getGameIcon('Dead Pid Game')).toBeNull();
  });
});


describe('execProgramName', () => {
  it('names the program an Exec line runs', () => {
    expect(execProgramName('/opt/mygame/bin/MyGame %U')).toBe('mygame');
    expect(execProgramName('env FOO=1 BAR=2 /opt/x/run')).toBe('run');
    expect(execProgramName('"/opt/my game/bin/start" --flag')).toBe('start');
    expect(execProgramName('java -jar a.jar')).toBe('java');
    expect(execProgramName('')).toBe('');
  });
});

describe('Wine programs', () => {
  const png = encodePng(1, 1, Buffer.from([10, 20, 30, 255]));
  const exe = () => buildPe([{ id: 1, data: png }], [{ width: 256, height: 256, bits: 32, id: 1 }]);

  it('takes the icon from the program .exe in the working directory', async () => {
    const cwd = path.join(home, 'Games', 'Zzz');
    write(path.join(cwd, 'ZenlessZoneZero.exe'), exe());
    const icon = await findGameIcon(target({ cwd, winExes: ['ZenlessZoneZero.exe'] }), home);
    expect(icon?.mime).toBe('image/png');
    expect(icon?.bytes.equals(png)).toBe(true);
  });

  it('finds the file whatever its letter case', async () => {
    const cwd = path.join(home, 'Games', 'Stardew');
    write(path.join(cwd, 'Stardew Valley.exe'), exe());
    const icon = await findGameIcon(target({ cwd, winExes: ['stardew valley.EXE'] }), home);
    expect(icon?.bytes.equals(png)).toBe(true);
  });

  it('tries the next program name when the first is not there', async () => {
    const cwd = path.join(home, 'Games', 'G');
    write(path.join(cwd, 'Real.exe'), exe());
    const icon = await findGameIcon(target({ cwd, winExes: ['Launcher.exe', 'Real.exe'] }), home);
    expect(icon?.bytes.equals(png)).toBe(true);
  });

  it('does not follow a name that leaves the working directory', async () => {
    write(path.join(home, 'Games', 'outside.exe'), exe());
    const cwd = path.join(home, 'Games', 'G');
    fs.mkdirSync(cwd, { recursive: true });
    expect(await findGameIcon(target({ cwd, winExes: ['../outside.exe', '..\\outside.exe'] }), home)).toBeNull();
  });

  it('is a miss without a working directory, without a program or with a broken file', async () => {
    const cwd = path.join(home, 'Games', 'G');
    write(path.join(cwd, 'Bad.exe'), Buffer.from('MZ nope'));
    expect(await findGameIcon(target({ winExes: ['Bad.exe'] }), home)).toBeNull();
    expect(await findGameIcon(target({ cwd }), home)).toBeNull();
    expect(await findGameIcon(target({ cwd, winExes: ['Bad.exe'] }), home)).toBeNull();
  });
});

describe('launcher games', () => {
  it('uses the icon Lutris keeps for a game it detected', async () => {
    write(path.join(home, '.config/lutris/games/named-1.yml'), Buffer.from('name: Named\ngame:\n  working_dir: /games/named\n'));
    write(path.join(home, '.local/share/icons/hicolor/128x128/apps/lutris_named.png'), PNG);
    const icon = await findGameIcon(target({ id: 'lutris-named', name: 'Named' }), home);
    expect(icon?.bytes.equals(PNG)).toBe(true);
  });

  it('finds the launcher game behind a dictionary match by its program and folder', async () => {
    write(path.join(home, '.config/lutris/games/zzz-1.yml'), Buffer.from('game:\n  exe: /games/zzz/ZenlessZoneZero.exe\n'));
    write(path.join(home, '.local/share/icons/hicolor/128x128/apps/lutris_zzz.png'), PNG);
    const icon = await findGameIcon(
      target({ id: 'zzz', name: 'Zenless Zone Zero', exe: '/runner/wine64-preloader', winExes: ['ZenlessZoneZero.exe'], cwd: '/games/zzz' }),
      home,
    );
    expect(icon?.bytes.equals(PNG)).toBe(true);
  });

  it('finds a Bottles game by the name the player gave it, and uses its icon', async () => {
    const bottle = path.join(home, '.local/share/bottles/bottles/B');
    write(path.join(bottle, 'bottle.yml'), Buffer.from('External_Programs:\n  Farm:\n    name: Farm\n    executable: Farm.exe\n'));
    write(path.join(bottle, 'icons', 'Farm.png'), PNG);
    const icon = await findGameIcon(target({ id: '', name: 'farm' }), home);
    expect(icon?.bytes.equals(PNG)).toBe(true);
  });
});
