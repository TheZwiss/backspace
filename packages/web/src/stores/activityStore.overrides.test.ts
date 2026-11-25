import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockWsSendAll = vi.fn();
vi.mock('../hooks/useWebSocket', () => ({
  wsSendAll: (...args: unknown[]) => mockWsSendAll(...args),
}));

const mockUpload = vi.fn();
vi.mock('../api/client', () => ({
  api: { gameIcons: { upload: (...args: unknown[]) => mockUpload(...args) } },
}));

import { useActivityStore } from './activityStore';
import { GAME_OVERRIDES_KEY } from '../utils/gameOverrides';
import type { Activity } from '@backspace/shared';

const RUNTIME: Activity = { type: 'playing', name: 'Steam Linux Runtime', timestamps: { start: 1000 } };
const MUSIC: Activity = { type: 'listening', name: 'Spotify' };

const getGameIcon = vi.fn<(name: string) => Promise<{ data: string; mime: string } | null>>();

function lastSent(): Activity[] {
  const calls = mockWsSendAll.mock.calls;
  return calls[calls.length - 1][0].activities as Activity[];
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  (window as unknown as { backspace: unknown }).backspace = { getGameIcon };
  getGameIcon.mockReset();
  getGameIcon.mockResolvedValue(null);
  useActivityStore.getState().reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { backspace: unknown }).backspace;
});

describe('manual games', () => {
  it('shows a game added by name when nothing is detected, and remembers it', async () => {
    useActivityStore.getState().addManualGame('  Hades  ');
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([{ type: 'playing', name: 'Hades' }]);
    expect(JSON.parse(localStorage.getItem(GAME_OVERRIDES_KEY) ?? '{}').manualGames).toEqual([{ name: 'Hades', process: null }]);
  });

  it('adds to a detected game instead of replacing it, and keeps other activity types', async () => {
    useActivityStore.getState().pushActivities([RUNTIME, MUSIC]);
    useActivityStore.getState().addManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([{ type: 'playing', name: 'Hades' }, RUNTIME, MUSIC]);
  });

  it('holds several at once', async () => {
    useActivityStore.getState().addManualGame('Hades');
    useActivityStore.getState().addManualGame('Celeste');
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent().map((a) => a.name).sort()).toEqual(['Celeste', 'Hades']);
  });

  it('survives the detector reporting nothing', async () => {
    useActivityStore.getState().addManualGame('Hades');
    useActivityStore.getState().pushActivities([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([{ type: 'playing', name: 'Hades' }]);
  });

  it('removing it goes back to what is detected', async () => {
    useActivityStore.getState().pushActivities([RUNTIME]);
    useActivityStore.getState().addManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    useActivityStore.getState().removeManualGame('hades');
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([RUNTIME]);
    expect(localStorage.getItem(GAME_OVERRIDES_KEY)).toBeNull();
  });

  it('removing the only one tells the others the player stopped', async () => {
    useActivityStore.getState().addManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    useActivityStore.getState().removeManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([]);
  });

  it('looks its icon up by the name the player typed', async () => {
    getGameIcon.mockResolvedValue({ data: 'aWNvbg==', mime: 'image/png' });
    mockUpload.mockResolvedValue({ id: 'a', url: 'https://chat.test/api/game-icons/assets/a.webp' });
    useActivityStore.getState().addManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    expect(getGameIcon).toHaveBeenCalledWith('Hades');
    expect(lastSent()[0].assets?.largeImage).toBe('https://chat.test/api/game-icons/assets/a.webp');
  });

  it('is not sent while sharing is off, and shows up when it is switched on', async () => {
    useActivityStore.getState().setShowActivity(false);
    mockWsSendAll.mockClear();
    useActivityStore.getState().addManualGame('Hades');
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWsSendAll).not.toHaveBeenCalled();
    useActivityStore.getState().setShowActivity(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([{ type: 'playing', name: 'Hades' }]);
  });

  it('is forgotten when the account signs out', () => {
    useActivityStore.getState().addManualGame('Hades');
    useActivityStore.getState().reset();
    expect(useActivityStore.getState().manualGames).toEqual([]);
    expect(localStorage.getItem(GAME_OVERRIDES_KEY)).toBeNull();
  });
});

describe('hidden games', () => {
  const A: Activity = { type: 'playing', name: 'Game A' };
  const B: Activity = { type: 'playing', name: 'Game B' };

  it('are detected but not sent, and come back when shown again', async () => {
    useActivityStore.getState().pushActivities([A, B]);
    useActivityStore.getState().setGameHidden('game a', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([B]);
    expect(useActivityStore.getState().detectedActivities).toEqual([A, B]);
    expect(JSON.parse(localStorage.getItem(GAME_OVERRIDES_KEY) ?? '{}').hidden).toEqual(['game a']);

    useActivityStore.getState().setGameHidden('Game A', false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([A, B]);
  });

  it('hiding the only game tells the others the player stopped', async () => {
    useActivityStore.getState().pushActivities([A]);
    await vi.advanceTimersByTimeAsync(5000);
    useActivityStore.getState().setGameHidden('Game A', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([]);
  });

  it('are hidden under the detected name even when renamed', async () => {
    useActivityStore.getState().setGameRename('Game A', 'Secret');
    useActivityStore.getState().setGameHidden('Game A', true);
    useActivityStore.getState().pushActivities([A, B]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([B]);
  });
});

describe('game order', () => {
  const A: Activity = { type: 'playing', name: 'Game A' };
  const B: Activity = { type: 'playing', name: 'Game B' };
  const C: Activity = { type: 'playing', name: 'Game C' };

  it('sends the games in the player\'s priority order, so the first leads', async () => {
    useActivityStore.getState().setGameOrder(['game c', 'game a']);
    useActivityStore.getState().pushActivities([A, B, C, MUSIC]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent().map((a) => a.name)).toEqual(['Game C', 'Game A', 'Game B', 'Spotify']);
    expect(JSON.parse(localStorage.getItem(GAME_OVERRIDES_KEY) ?? '{}').order).toEqual(['game c', 'game a']);
  });

  it('applies to games the desktop reports for a tied program', async () => {
    useActivityStore.getState().setGameOrder(['mine']);
    useActivityStore.getState().pushActivities([A, { type: 'playing', name: 'Mine' }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent().map((a) => a.name)).toEqual(['Mine', 'Game A']);
  });

  it('cuts to the five the server accepts after ordering, so a hidden game does not take a place', async () => {
    const six = Array.from({ length: 6 }, (_, i): Activity => ({ type: 'playing', name: `G${i}` }));
    useActivityStore.getState().setGameHidden('G0', true);
    useActivityStore.getState().pushActivities(six);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent().map((a) => a.name)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
  });
});

describe('renamed games', () => {
  it('shows a detected game under the chosen name, case-insensitively, and keeps the rest', async () => {
    useActivityStore.getState().setGameRename('steam linux runtime', 'Hades');
    useActivityStore.getState().pushActivities([RUNTIME]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([{ ...RUNTIME, name: 'Hades' }]);
  });

  it('is applied after the icon lookup, which goes by the detected name', async () => {
    getGameIcon.mockResolvedValue({ data: 'aWNvbg==', mime: 'image/png' });
    mockUpload.mockResolvedValue({ id: 'a', url: 'https://chat.test/api/game-icons/assets/a.webp' });
    useActivityStore.getState().setGameRename('Steam Linux Runtime', 'Hades');
    useActivityStore.getState().pushActivities([RUNTIME]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getGameIcon).toHaveBeenCalledWith('Steam Linux Runtime');
    expect(getGameIcon).not.toHaveBeenCalledWith('Hades');
    expect(lastSent()[0].name).toBe('Hades');
  });

  it('is remembered and applies to the next detection, until restored', async () => {
    useActivityStore.getState().setGameRename('Steam Linux Runtime', 'Hades');
    useActivityStore.getState().pushActivities([]);
    useActivityStore.getState().pushActivities([RUNTIME]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()[0].name).toBe('Hades');

    useActivityStore.getState().setGameRename('Steam Linux Runtime', null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()[0].name).toBe('Steam Linux Runtime');
  });

  it('does not rename music', async () => {
    useActivityStore.getState().setGameRename('Spotify', 'Other');
    useActivityStore.getState().pushActivities([MUSIC]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([MUSIC]);
  });
});

describe('manual games tied to a program', () => {
  const setBindings = vi.fn(() => Promise.resolve());
  beforeEach(() => {
    setBindings.mockClear();
    (window as unknown as { backspace: unknown }).backspace = { getGameIcon, setManualGameBindings: setBindings };
  });

  it('hands every tied game to the desktop and remembers them', () => {
    useActivityStore.getState().addManualGame('Hades', ' Hades.exe ');
    useActivityStore.getState().addManualGame('Weird', 'Weird.exe');
    useActivityStore.getState().addManualGame('By name');
    expect(setBindings).toHaveBeenLastCalledWith([
      { name: 'Hades', process: 'Hades.exe' },
      { name: 'Weird', process: 'Weird.exe' },
    ]);
    expect(JSON.parse(localStorage.getItem(GAME_OVERRIDES_KEY) ?? '{}').manualGames).toHaveLength(3);
  });

  it('adds nothing itself: the desktop reports the game while the program runs', async () => {
    useActivityStore.getState().addManualGame('Hades', 'Hades.exe');
    useActivityStore.getState().pushActivities([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([]); // program not running: nothing to say

    const reported: Activity = { type: 'playing', name: 'Hades', timestamps: { start: 5 } };
    useActivityStore.getState().pushActivities([reported, RUNTIME]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([reported, RUNTIME]); // other detected games stay
  });

  it('stops when the program stops', async () => {
    const reported: Activity = { type: 'playing', name: 'Hades' };
    useActivityStore.getState().addManualGame('Hades', 'Hades.exe');
    useActivityStore.getState().pushActivities([reported]);
    await vi.advanceTimersByTimeAsync(5000);
    useActivityStore.getState().pushActivities([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()).toEqual([]);
  });

  it('removing one updates the desktop', () => {
    useActivityStore.getState().addManualGame('Hades', 'Hades.exe');
    useActivityStore.getState().addManualGame('Weird', 'Weird.exe');
    useActivityStore.getState().removeManualGame('hades');
    expect(setBindings).toHaveBeenLastCalledWith([{ name: 'Weird', process: 'Weird.exe' }]);
  });

  it('reset forgets the bindings on the desktop too', () => {
    useActivityStore.getState().addManualGame('Hades', 'Hades.exe');
    useActivityStore.getState().reset();
    expect(setBindings).toHaveBeenLastCalledWith([]);
  });

  it('a desktop from before the list follows the first tied program', () => {
    const single = vi.fn(() => Promise.resolve());
    (window as unknown as { backspace: unknown }).backspace = { getGameIcon, setManualGameBinding: single };
    useActivityStore.getState().addManualGame('Hades', 'Hades.exe');
    expect(single).toHaveBeenLastCalledWith({ name: 'Hades', process: 'Hades.exe' });
  });
});

describe('icon renewal', () => {
  const CACHE_KEY = 'backspace_game_icons';
  const SEEN_KEY = 'backspace_game_icons_seen';
  const DAY = 24 * 60 * 60 * 1000;
  const GAME: Activity = { type: 'playing', name: 'Hades' };

  beforeEach(() => {
    mockUpload.mockResolvedValue({ id: 'a', url: 'https://chat.test/api/game-icons/assets/a.webp' });
    getGameIcon.mockResolvedValue({ data: 'AAAA', mime: 'image/png' });
    localStorage.setItem(CACHE_KEY, JSON.stringify({ Hades: 'https://chat.test/api/game-icons/assets/a.webp' }));
  });

  it('uploads again an icon last uploaded over a month ago, without delaying the send', async () => {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ Hades: Date.now() - 31 * DAY }));
    useActivityStore.getState().pushActivities([GAME]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSent()[0]?.assets?.largeImage).toBe('https://chat.test/api/game-icons/assets/a.webp');
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}').Hades).toBeGreaterThan(Date.now() - 60_000);
  });

  it('leaves a recently uploaded icon alone', async () => {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ Hades: Date.now() - 2 * DAY }));
    useActivityStore.getState().pushActivities([GAME]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('treats an icon cached before the date was kept as due', async () => {
    useActivityStore.getState().pushActivities([GAME]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });
});

describe('renaming a manual game', () => {
  const setBindings = vi.fn(() => Promise.resolve());
  beforeEach(() => {
    setBindings.mockClear();
    (window as unknown as { backspace: unknown }).backspace = { getGameIcon, setManualGameBindings: setBindings };
  });

  it('keeps the program, moves hidden and order, and hands the new name to the desktop', () => {
    const store = useActivityStore.getState();
    store.addManualGame('Hades', 'Hades.exe');
    store.addManualGame('Other', 'other.exe');
    store.setGameHidden('Hades', true);
    store.setGameOrder(['other', 'hades']);
    setBindings.mockClear();

    useActivityStore.getState().renameManualGame('Hades', 'Hades II');
    const state = useActivityStore.getState();
    expect(state.manualGames).toEqual([
      { name: 'Hades II', process: 'Hades.exe' },
      { name: 'Other', process: 'other.exe' },
    ]);
    expect(state.hiddenGames).toEqual(['hades ii']);
    expect(state.gameOrder).toEqual(['other', 'hades ii']);
    expect(setBindings).toHaveBeenLastCalledWith([
      { name: 'Hades II', process: 'Hades.exe' },
      { name: 'Other', process: 'other.exe' },
    ]);
    expect(JSON.parse(localStorage.getItem(GAME_OVERRIDES_KEY) ?? '{}').manualGames[0].name).toBe('Hades II');
  });

  it('ignores a blank, unchanged or colliding name', () => {
    const store = useActivityStore.getState();
    store.addManualGame('Hades', 'Hades.exe');
    store.addManualGame('Other');
    setBindings.mockClear();
    for (const to of ['  ', 'Hades', 'other']) useActivityStore.getState().renameManualGame('Hades', to);
    expect(useActivityStore.getState().manualGames.map((g) => g.name)).toEqual(['Hades', 'Other']);
    expect(setBindings).not.toHaveBeenCalled();
  });
});

describe('removing a manual game', () => {
  it('takes its hidden state and place with it, so it vanishes from the list at once', () => {
    const store = useActivityStore.getState();
    store.addManualGame('Hades');
    store.addManualGame('Other');
    store.setGameHidden('Hades', true);
    store.setGameOrder(['other', 'hades']);
    useActivityStore.getState().removeManualGame('Hades');
    const state = useActivityStore.getState();
    expect(state.manualGames.map((g) => g.name)).toEqual(['Other']);
    expect(state.hiddenGames).toEqual([]);
    expect(state.gameOrder).toEqual(['other']);
  });

  it('forgets a hidden game tied to a running program even while the desktop still reports it', () => {
    const store = useActivityStore.getState();
    store.addManualGame('synochat', 'synochat');
    store.setGameHidden('synochat', true);
    useActivityStore.setState({ detectedActivities: [{ type: 'playing', name: 'synochat' }] });
    useActivityStore.getState().removeManualGame('synochat');
    const state = useActivityStore.getState();
    expect(state.hiddenGames).toEqual([]);
    expect(state.detectedActivities).toEqual([]);
  });

  it('keeps the choices of a game that is still detected', () => {
    const store = useActivityStore.getState();
    store.addManualGame('Hades'); // by name only
    store.setGameHidden('Hades', true);
    useActivityStore.setState({ detectedActivities: [{ type: 'playing', name: 'Hades' }] });
    useActivityStore.getState().removeManualGame('Hades');
    expect(useActivityStore.getState().hiddenGames).toEqual(['hades']);
  });
});
