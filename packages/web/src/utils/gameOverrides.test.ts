import { beforeEach, describe, expect, it } from 'vitest';
import {
  GAME_OVERRIDES_KEY,
  MAX_GAME_RENAMES,
  addManualGame,
  boundGames,
  loadOverrides,
  moveKey,
  moveKeyTo,
  orderedKeys,
  removeManualGame,
  renameKeyIn,
  renameManualGame,
  sanitizeGameName,
  saveOverrides,
  setHidden,
  setRename,
  withManualGames,
  withOrder,
  withoutHidden,
  withRenames,
} from './gameOverrides';
import type { Activity } from '@backspace/shared';

beforeEach(() => localStorage.clear());

describe('sanitizeGameName', () => {
  it('collapses whitespace, drops control characters and caps the length', () => {
    expect(sanitizeGameName('  Half \t Life\n2 ')).toBe('Half Life 2');
    expect(sanitizeGameName('a\u0000b')).toBe('a b');
    expect(sanitizeGameName('x'.repeat(500))).toHaveLength(128);
  });

  it('is null for nothing', () => {
    expect(sanitizeGameName('   \n')).toBeNull();
  });
});

describe('loadOverrides', () => {
  it('survives junk in storage', () => {
    localStorage.setItem(GAME_OVERRIDES_KEY, 'not json');
    expect(loadOverrides()).toEqual({ manualGames: [], hidden: [], order: [], renames: {} });
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify({ manual: 5, renames: { a: 7, b: 'Ok', '': 'x' } }));
    expect(loadOverrides()).toEqual({ manualGames: [], hidden: [], order: [], renames: { b: 'Ok' } });
  });

  it('turns the single manual game of an earlier version into a one-item list', () => {
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify({ manual: 'Hades', manualProcess: ' Hades.exe ', renames: {} }));
    expect(loadOverrides().manualGames).toEqual([{ name: 'Hades', process: 'Hades.exe' }]);
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify({ manual: 'Hades', manualProcess: 7 }));
    expect(loadOverrides().manualGames).toEqual([{ name: 'Hades', process: null }]);
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify({ manualProcess: 'Hades.exe' }));
    expect(loadOverrides().manualGames).toEqual([]);
  });

  it('round-trips the lists and cleans them up on load', () => {
    saveOverrides({ manualGames: [{ name: 'A', process: 'a.exe' }], hidden: ['b'], order: ['c', 'a'], renames: {} });
    expect(loadOverrides()).toEqual({ manualGames: [{ name: 'A', process: 'a.exe' }], hidden: ['b'], order: ['c', 'a'], renames: {} });
    localStorage.setItem(GAME_OVERRIDES_KEY, JSON.stringify({
      manualGames: [{ name: 'A' }, { name: ' a ', process: 'x' }, { name: '' }, 5, null],
      hidden: ['X', 'x', 7, ''],
      order: 'nope',
    }));
    expect(loadOverrides()).toMatchObject({ manualGames: [{ name: 'A', process: null }], hidden: ['x'], order: [] });
  });

  it('stores nothing at all when every choice is empty', () => {
    saveOverrides({ manualGames: [], hidden: [], order: [], renames: {} });
    expect(localStorage.getItem(GAME_OVERRIDES_KEY)).toBeNull();
  });
});

describe('manual games', () => {
  it('adds, replaces by name and removes', () => {
    let games = addManualGame([], '  Half   Life ', null);
    games = addManualGame(games, 'Weird', 'Weird.exe');
    games = addManualGame(games, 'half life', 'hl.exe');
    expect(games).toEqual([{ name: 'Weird', process: 'Weird.exe' }, { name: 'half life', process: 'hl.exe' }]);
    expect(addManualGame(games, '   ', null)).toBe(games);
    expect(removeManualGame(games, 'WEIRD')).toEqual([{ name: 'half life', process: 'hl.exe' }]);
  });

  it('lists the tied ones for the desktop', () => {
    expect(boundGames([{ name: 'A', process: null }, { name: 'B', process: 'b.exe' }])).toEqual([{ name: 'B', process: 'b.exe' }]);
  });

  it('adds only the games without a program, once, and keeps the rest of the list', () => {
    const list: Activity[] = [{ type: 'playing', name: 'Weird' }, { type: 'listening', name: 'M' }];
    const out = withManualGames(list, [
      { name: 'weird', process: null },
      { name: 'By Name', process: null },
      { name: 'Tied', process: 'tied.exe' },
    ]);
    expect(out.map((a) => a.name)).toEqual(['By Name', 'Weird', 'M']);
    expect(withManualGames(list, [{ name: 'Tied', process: 'tied.exe' }])).toBe(list);
  });
});

describe('hidden games and order', () => {
  const game = (name: string): Activity => ({ type: 'playing', name });
  const music: Activity = { type: 'listening', name: 'M' };

  it('leaves out hidden games only, ignoring case', () => {
    const list = [game('A'), music, game('B')];
    expect(withoutHidden(list, ['a'])).toEqual([music, game('B')]);
    expect(withoutHidden(list, [])).toBe(list);
    expect(withoutHidden(list, ['zzz'])).toBe(list);
  });

  it('hides and shows', () => {
    expect(setHidden([], ' A ', true)).toEqual(['a']);
    expect(setHidden(['a'], 'A', true)).toEqual(['a']);
    expect(setHidden(['a', 'b'], 'A', false)).toEqual(['b']);
  });

  it('puts games in the player\'s order, unlisted ones last, other types where they were', () => {
    const list = [game('A'), music, game('B'), game('C')];
    expect(withOrder(list, ['c', 'a']).map((a) => a.name)).toEqual(['C', 'M', 'A', 'B']);
    expect(withOrder(list, [])).toBe(list);
    expect(withOrder(list, ['a', 'b', 'c'])).toBe(list);
  });

  it('works out the order to show and moves one place at a time', () => {
    expect(orderedKeys(['a', 'b', 'c'], ['c', 'zzz', 'a'])).toEqual(['c', 'a', 'b']);
    expect(moveKey(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    const keys = ['a', 'b'];
    expect(moveKey(keys, 'a', -1)).toBe(keys);
    expect(moveKey(keys, 'b', 1)).toBe(keys);
    expect(moveKey(keys, 'zzz', 1)).toBe(keys);
  });
});

describe('withRenames', () => {
  const list: Activity[] = [{ type: 'playing', name: 'A' }, { type: 'listening', name: 'M' }];

  it('returns the very same list when there is nothing to apply', () => {
    expect(withRenames(list, {})).toBe(list);
    expect(withRenames(list, { zzz: 'Q' })).toBe(list);
  });

});

describe('setRename', () => {
  it('drops the oldest past the cap', () => {
    let renames: Record<string, string> = {};
    for (let i = 0; i < MAX_GAME_RENAMES + 3; i++) renames = setRename(renames, `game${i}`, `Name ${i}`);
    expect(Object.keys(renames)).toHaveLength(MAX_GAME_RENAMES);
    expect(renames['game0']).toBeUndefined();
    expect(renames[`game${MAX_GAME_RENAMES + 2}`]).toBe(`Name ${MAX_GAME_RENAMES + 2}`);
  });

  it('removes the entry for a blank or unchanged name', () => {
    expect(setRename({ a: 'B' }, 'A', '  ')).toEqual({});
    expect(setRename({ a: 'B' }, 'A', 'A')).toEqual({});
  });
});

describe('renameManualGame', () => {
  const games = [{ name: 'Hades', process: 'Hades.exe' }, { name: 'Other', process: null }];

  it('renames in place and keeps the program', () => {
    expect(renameManualGame(games, 'hades', '  Hades   II ')).toEqual([{ name: 'Hades II', process: 'Hades.exe' }, games[1]]);
  });

  it('allows changing only the letter case', () => {
    expect(renameManualGame(games, 'Hades', 'HADES')?.[0]?.name).toBe('HADES');
  });

  it('refuses blank, identical, unknown and colliding names', () => {
    expect(renameManualGame(games, 'Hades', ' ')).toBeNull();
    expect(renameManualGame(games, 'Hades', 'Hades')).toBeNull();
    expect(renameManualGame(games, 'Nope', 'X')).toBeNull();
    expect(renameManualGame(games, 'Hades', 'other')).toBeNull();
  });
});

describe('renameKeyIn', () => {
  it('follows the new name and keeps the place', () => {
    expect(renameKeyIn(['a', 'hades', 'b'], 'Hades', 'Hades II')).toEqual(['a', 'hades ii', 'b']);
  });
  it('leaves lists without the game alone', () => {
    const keys = ['a'];
    expect(renameKeyIn(keys, 'Hades', 'X')).toBe(keys);
  });
});

describe('moveKeyTo', () => {
  const keys = ['a', 'b', 'c', 'd'];
  it('puts the key where the target was, in both directions', () => {
    expect(moveKeyTo(keys, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveKeyTo(keys, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });
  it('ignores unknown keys and a drop on itself', () => {
    expect(moveKeyTo(keys, 'a', 'a')).toBe(keys);
    expect(moveKeyTo(keys, 'x', 'a')).toBe(keys);
    expect(moveKeyTo(keys, 'a', 'x')).toBe(keys);
  });
});
