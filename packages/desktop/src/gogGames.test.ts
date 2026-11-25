import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseGogInfo,
  getGogGamesDir,
  loadGogIndex,
  resetGogIndexCache,
  findGogGameForProcess,
} from './gogGames';

// ─── parseGogInfo ───────────────────────────────────────────────────────────

describe('parseGogInfo', () => {
  it('reads an object-form info file', () => {
    expect(parseGogInfo('{"gameId":"1207658924","name":"Terraria","os":"linux"}'))
      .toEqual({ name: 'Terraria', gameId: '1207658924' });
  });

  it('reads an array-form info file (first record)', () => {
    expect(parseGogInfo('[{"gameId":"1","name":"Game A"},{"gameId":"2","name":"Game B"}]'))
      .toEqual({ name: 'Game A', gameId: '1' });
  });

  it('returns nulls for corrupt or empty input', () => {
    expect(parseGogInfo('not json')).toEqual({ name: null, gameId: null });
    expect(parseGogInfo('[]')).toEqual({ name: null, gameId: null });
    expect(parseGogInfo('{"buildId": 1}')).toEqual({ name: null, gameId: null });
  });
});

// ─── index ──────────────────────────────────────────────────────────────────

function makeGogHome(games: Array<{ dir: string; info?: { gameId?: string; name?: string } }>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gog-home-'));
  for (const g of games) {
    const dir = path.join(home, 'GOG Games', g.dir);
    fs.mkdirSync(dir, { recursive: true });
    if (g.info) {
      fs.writeFileSync(
        path.join(dir, `goggame-${g.info.gameId ?? '0'}.info`),
        JSON.stringify({ gameId: g.info.gameId ?? '0', name: g.info.name ?? g.dir, ...g.info }),
      );
    }
  }
  return home;
}

describe('loadGogIndex', () => {
  beforeEach(() => resetGogIndexCache());

  it('indexes games with names from info files', () => {
    const home = makeGogHome([
      { dir: 'Terraria', info: { gameId: '1207658924', name: 'Terraria' } },
      { dir: 'No Info Game' },
    ]);
    const games = loadGogIndex(home, true);
    expect(games).toHaveLength(2);
    const terraria = games.find((g) => g.name === 'Terraria');
    expect(terraria?.id).toBe('1207658924');
    expect(terraria?.dir).toBe(path.join(home, 'GOG Games', 'Terraria'));
    const fallback = games.find((g) => g.dir.endsWith('No Info Game'));
    expect(fallback?.name).toBe('No Info Game');
    expect(fallback?.id).toBe('No Info Game');
  });

  it('returns an empty list without a GOG Games dir', () => {
    expect(loadGogIndex(fs.mkdtempSync(path.join(os.tmpdir(), 'gog-empty-')), true)).toEqual([]);
  });

  it('resolves the games dir under home', () => {
    expect(getGogGamesDir('/home/u')).toBe('/home/u/GOG Games');
  });
});

// ─── matching ───────────────────────────────────────────────────────────────

describe('findGogGameForProcess', () => {
  const games = [
    { id: '1207658924', name: 'Terraria', dir: '/home/u/GOG Games/Terraria' },
  ];

  it('matches an exe under the game directory, case-insensitively', () => {
    expect(findGogGameForProcess('/home/u/GOG Games/Terraria/Terraria.bin', '', games)?.name).toBe('Terraria');
    expect(findGogGameForProcess('/home/u/gog games/terraria/Terraria.bin', '', games)?.name).toBe('Terraria');
  });

  it('falls back to the command line for start.sh wrappers', () => {
    expect(findGogGameForProcess('/bin/bash', '/bin/sh /home/u/GOG Games/Terraria/start.sh', games)?.name).toBe('Terraria');
  });

  it('rejects unrelated processes', () => {
    expect(findGogGameForProcess('/usr/bin/obs', 'obs --startrecording', games)).toBeNull();
    expect(findGogGameForProcess(null, '', games)).toBeNull();
    expect(findGogGameForProcess(null, '/bin/sh /opt/start.sh', games)).toBeNull();
  });

  it('rejects sibling directories sharing a name prefix', () => {
    expect(findGogGameForProcess('/home/u/GOG Games/Terraria Other/game.bin', '', games)).toBeNull();
  });
});
