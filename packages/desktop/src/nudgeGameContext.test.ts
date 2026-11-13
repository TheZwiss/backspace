import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Display } from 'electron';
import { detectNudgeGames, hasNudgeGameActivity, isWallpaperEngineProcess, type Geometry } from './nudgeGameContext';

const mocks = vi.hoisted(() => ({ sources: vi.fn(), displays: [
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
] }));
vi.mock('electron', () => ({ desktopCapturer: { getSources: mocks.sources }, screen: { getAllDisplays: () => mocks.displays } }));
const options = () => ({ query: vi.fn(async (): Promise<Geometry> => ({ window: [0, 0, 1900, 1000], monitor: [0, 0, 1920, 1080], minimized: false, foreground: true, process: 'game.exe' })),
  isGame: (process: string): boolean => process === 'game.exe', knownGameRunning: false, physicalBounds: (display: Display) => display.bounds, platform: 'win32' as const });

describe('on-demand game display detection', () => {
  beforeEach(() => { mocks.sources.mockResolvedValue([{ id: 'window:123:0' }]); });
  it('finds foreground games without requesting thumbnails', async () => {
    const result = await detectNudgeGames(options());
    expect(result).toMatchObject({ gameRunning: true, foregroundGame: true, gameDisplayIds: [1], gameDetectionUncertain: false });
    expect(mocks.sources).toHaveBeenCalledWith({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  });
  it('protects all intersected physical display rectangles', async () => {
    const input = options(); input.query.mockResolvedValue({ window: [-10, 0, 20, 100], monitor: [0, 0, 1920, 1080], minimized: false, foreground: true, process: 'game.exe' });
    expect((await detectNudgeGames(input)).gameDisplayIds).toEqual([1, 2]);
  });
  it('ignores minimized games', async () => {
    const input = options(); input.query.mockResolvedValue({ window: [0, 0, 1900, 1000], monitor: [0, 0, 1920, 1080], minimized: true, foreground: false, process: 'game.exe' });
    expect((await detectNudgeGames(input)).gameDisplayIds).toEqual([]);
  });
  it('reports unavailable platform detection without guessing a free screen', async () => {
    const result = await detectNudgeGames({ ...options(), platform: 'linux', knownGameRunning: true });
    expect(result).toMatchObject({ gameRunning: true, gameDetectionUncertain: true, gameDisplayIds: [] });
  });
  it('marks enumeration failures as uncertain', async () => {
    mocks.sources.mockRejectedValue(new Error('unavailable'));
    expect((await detectNudgeGames(options())).gameDetectionUncertain).toBe(true);
  });
  it.each(['wallpaper32.exe', 'Wallpaper64.exe', 'wallpaperservice32.exe', 'C:\\Steam\\Wallpaper Engine\\wallpaper64.exe'])('excludes %s from game protection', async process => {
    const input = options();
    input.isGame = () => true;
    input.query.mockResolvedValue({ window: [0, 0, 1920, 1080], monitor: [0, 0, 1920, 1080], minimized: false, foreground: true, process, exclusive: true });
    expect((await detectNudgeGames(input))).toMatchObject({ gameRunning: false, foregroundGame: false, gameDisplayIds: [] });
  });
  it('does not count wallpaper activity, but retains genuine games alongside it', () => {
    expect(hasNudgeGameActivity([{ type: 'playing', name: 'Wallpaper Engine' }])).toBe(false);
    expect(hasNudgeGameActivity([{ type: 'playing', name: 'Wallpaper Engine' }, { type: 'playing', name: 'Fortnite' }])).toBe(true);
    expect(isWallpaperEngineProcess('FortniteClient-Win64-Shipping.exe')).toBe(false);
  });
});
