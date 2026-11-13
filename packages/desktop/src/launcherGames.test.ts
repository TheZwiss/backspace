import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findLauncherGameForProcess,
  loadLauncherIndex,
  nameFromSlug,
  parseSimpleYaml,
  resetLauncherIndexCache,
  type LauncherGame,
} from './launcherGames';

let home: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const json = (value: unknown) => JSON.stringify(value);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'launchers-'));
  resetLauncherIndexCache();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('parseSimpleYaml', () => {
  it('reads nested mappings, quoted keys and values with colons', () => {
    const yaml = parseSimpleYaml([
      'Name: Stardew',
      'Runner: soda-9.0-1',
      'External_Programs:',
      "  'Stardew Valley':",
      '    name: Stardew Valley',
      "    executable: 'Stardew Valley.exe'",
      '    path: C:\\GOG Games\\Stardew Valley\\Stardew Valley.exe',
      '    args: ""',
      '  Other:',
      '    name: Other # trailing comment',
      'Environment_Variables: {}',
      'List:',
      '- a',
      '- b',
    ].join('\n'));
    expect(yaml.Name).toBe('Stardew');
    const programs = yaml.External_Programs as Record<string, Record<string, string>>;
    expect(programs['Stardew Valley']?.executable).toBe('Stardew Valley.exe');
    expect(programs['Stardew Valley']?.path).toBe('C:\\GOG Games\\Stardew Valley\\Stardew Valley.exe');
    expect(programs['Stardew Valley']?.args).toBe('');
    expect(programs.Other?.name).toBe('Other');
  });

  it('does not choke on junk', () => {
    expect(parseSimpleYaml('\u0000\u0001: : :\n  - - -\n{{{')).toBeTypeOf('object');
    expect(parseSimpleYaml('')).toEqual({});
  });
});

describe('nameFromSlug', () => {
  it('title-cases a slug', () => {
    expect(nameFromSlug('zenless-zone-zero')).toBe('Zenless Zone Zero');
    expect(nameFromSlug('half_life')).toBe('Half Life');
  });
});

describe('Heroic', () => {
  const config = () => path.join(home, '.config', 'heroic');

  it('reads Epic, GOG, Amazon and sideloaded games', () => {
    write(path.join(config(), 'legendaryConfig', 'legendary', 'installed.json'), json({
      Sugar: { title: 'Rocket League', install_path: '/games/RL', executable: 'Binaries/Win64/RocketLeague.exe' },
      Broken: 5,
    }));
    write(path.join(config(), 'gog_store', 'installed.json'), json({ installed: [{ appName: '1', install_path: '/games/gogame' }] }));
    write(path.join(config(), 'gog_store', 'library.json'), json({ games: [{ app_name: '1', title: 'GOG Game' }] }));
    write(path.join(config(), 'nile_config', 'nile', 'installed.json'), json([{ id: 'a1', path: '/games/amz' }]));
    write(path.join(config(), 'store_cache', 'nile_library.json'), json({ library: [{ id: 'a1', title: 'Amazon Game' }] }));
    write(path.join(config(), 'sideload_apps', 'library.json'), json({ games: [{ app_name: 'x', title: 'Side Game', install: { executable: '/games/side/Side.exe' } }] }));

    const games = loadLauncherIndex(home, true);
    const byId = Object.fromEntries(games.map((g) => [g.id, g]));
    expect(byId['heroic-epic-Sugar']).toMatchObject({ name: 'Rocket League', exeNames: ['rocketleague.exe'], dir: '/games/RL' });
    expect(byId['heroic-gog-1']).toMatchObject({ name: 'GOG Game', dir: '/games/gogame' });
    expect(byId['heroic-amazon-a1']?.name).toBe('Amazon Game');
    expect(byId['heroic-sideload-x']).toMatchObject({ name: 'Side Game', exeNames: ['side.exe'], dir: '/games/side' });
    expect(games).toHaveLength(4);
  });

  it('takes the GOG title and play task from the install\'s own info when the library lacks it', () => {
    const install = path.join(home, 'gog', 'Game');
    write(path.join(install, 'goggame-7.info'), json({ name: 'From Info', playTasks: [{ path: 'Game.exe' }, { isPrimary: true, path: 'bin\\Real.exe' }] }));
    write(path.join(config(), 'gog_store', 'installed.json'), json({ installed: [{ appName: '7', install_path: install }] }));
    const game = loadLauncherIndex(home, true).find((g) => g.id === 'heroic-gog-7');
    expect(game).toMatchObject({ name: 'From Info', exeNames: ['real.exe'] });
  });

  it('also reads the Flatpak config and survives broken files', () => {
    write(path.join(home, '.var/app/com.heroicgameslauncher.hgl/config/heroic/legendaryConfig/legendary/installed.json'), json({ A: { title: 'Flat', install_path: '/g/flat' } }));
    write(path.join(config(), 'gog_store', 'installed.json'), 'not json');
    expect(loadLauncherIndex(home, true).map((g) => g.name)).toEqual(['Flat']);
  });
});

describe('Bottles', () => {
  it('reads a bottle\'s programs, with the icon Bottles keeps', () => {
    const bottle = path.join(home, '.var/app/com.usebottles.bottles/data/bottles/bottles/Stardew');
    write(path.join(bottle, 'bottle.yml'), [
      'Name: Stardew',
      'External_Programs:',
      '  Stardew Valley:',
      '    name: Stardew Valley',
      '    executable: Stardew Valley.exe',
      '    path: C:\\GOG Games\\Stardew Valley\\Stardew Valley.exe',
      '  Native:',
      '    name: Hosted',
      '    executable: Hosted.exe',
      `    path: ${bottle}/drive_c/Hosted/Hosted.exe`,
      '  NoExe:',
      '    name: Nothing',
    ].join('\n'));
    write(path.join(bottle, 'icons', 'Stardew Valley.png'), 'png');
    const games = loadLauncherIndex(home, true);
    const stardew = games.find((g) => g.name === 'Stardew Valley');
    expect(stardew).toMatchObject({ id: 'bottles-Stardew-Stardew Valley', exeNames: ['stardew valley.exe'], dir: null });
    expect(stardew?.iconPath).toBe(path.join(bottle, 'icons', 'Stardew Valley.png'));
    expect(games.find((g) => g.name === 'Hosted')?.dir).toBe(`${bottle}/drive_c/Hosted`);
    expect(games.find((g) => g.name === 'Nothing')).toBeUndefined();
  });
});

describe('Lutris', () => {
  it('reads a game config, naming it from the config or its slug', () => {
    const dir = path.join(home, '.config/lutris/games');
    write(path.join(dir, 'zenless-zone-zero-1700000000.yml'), 'game:\n  exe: /games/zzz/ZenlessZoneZero.exe\n  prefix: /p\nwine:\n  version: x\n');
    write(path.join(dir, 'named-1.yml'), 'name: The Named One\ngame:\n  working_dir: /games/named\n');
    write(path.join(dir, 'empty-2.yml'), 'game:\n  prefix: /p\n');
    write(path.join(dir, 'not-a-config.txt'), 'x');
    write(path.join(home, '.local/share/icons/hicolor/128x128/apps/lutris_named.png'), 'png');
    const games = loadLauncherIndex(home, true);
    expect(games.map((g) => g.id).sort()).toEqual(['lutris-named', 'lutris-zenless-zone-zero']);
    expect(games.find((g) => g.id === 'lutris-zenless-zone-zero')).toMatchObject({ name: 'Zenless Zone Zero', dir: '/games/zzz', exeNames: ['zenlesszonezero.exe'] });
    const named = games.find((g) => g.id === 'lutris-named');
    expect(named?.name).toBe('The Named One');
    expect(named?.iconPath).toBe(path.join(home, '.local/share/icons/hicolor/128x128/apps/lutris_named.png'));
  });
});

describe('findLauncherGameForProcess', () => {
  const game = (over: Partial<LauncherGame>): LauncherGame => ({
    id: 'heroic-epic-A', name: 'A', kind: 'heroic', exeNames: ['a.exe'], dir: '/games/a', iconPath: null, ...over,
  });
  const wine = (over: object) => ({ exe: '/runner/wine64-preloader', cmdline: 'wine64-preloader', winExes: ['A.exe'], ...over });

  it('matches a Wine program by name and by the folder it runs in', () => {
    expect(findLauncherGameForProcess(wine({ cwd: '/games/a/bin' }), [game({})])?.id).toBe('heroic-epic-A');
    expect(findLauncherGameForProcess(wine({ cwd: '/elsewhere' }), [game({})])).toBeNull();
    expect(findLauncherGameForProcess(wine({ cwd: '/elsewhere', cmdline: 'Z:\\games\\a\\A.exe' }), [game({})])?.id).toBe('heroic-epic-A');
  });

  it('does not take a program of the same name from another folder', () => {
    expect(findLauncherGameForProcess(wine({ winExes: ['Game.exe'], cwd: '/b' }), [game({ exeNames: ['game.exe'], dir: '/a' })])).toBeNull();
  });

  it('matches by name alone when the launcher gives no folder (Bottles)', () => {
    const bottle = game({ id: 'bottles-B-A', kind: 'bottles', dir: null });
    expect(findLauncherGameForProcess(wine({}), [bottle])?.id).toBe('bottles-B-A');
    expect(findLauncherGameForProcess(wine({ winExes: ['Other.exe'] }), [bottle])).toBeNull();
  });

  it('matches a folder alone when the launcher names no program', () => {
    expect(findLauncherGameForProcess(wine({ winExes: ['Anything.exe'], cwd: '/games/a' }), [game({ exeNames: [] })])?.id).toBe('heroic-epic-A');
    expect(findLauncherGameForProcess(wine({ cwd: '/z' }), [game({ exeNames: [], dir: null })])).toBeNull();
  });

  it('matches a native process by its folder', () => {
    expect(findLauncherGameForProcess({ exe: '/games/a/bin/game', cmdline: 'game' }, [game({})])?.id).toBe('heroic-epic-A');
    expect(findLauncherGameForProcess({ exe: '/games/ab/game', cmdline: 'game' }, [game({})])).toBeNull();
    expect(findLauncherGameForProcess({ exe: '/usr/bin/bash', cmdline: 'bash' }, [game({ dir: null })])).toBeNull();
  });
});
