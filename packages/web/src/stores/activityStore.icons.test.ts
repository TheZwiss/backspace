import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock useWebSocket before importing activityStore
const mockWsSendAll = vi.fn();
vi.mock('../hooks/useWebSocket', () => ({
  wsSendAll: (...args: unknown[]) => mockWsSendAll(...args),
}));

// Mock the api client: the icon upload is the only call the store makes
const mockUpload = vi.fn();
vi.mock('../api/client', () => ({
  api: { gameIcons: { upload: (...args: unknown[]) => mockUpload(...args) } },
}));

import { useActivityStore } from './activityStore';
import type { Activity } from '@backspace/shared';

const GAME_ACTIVITY: Activity = {
  type: 'playing',
  name: 'Minecraft',
  timestamps: { start: Date.now() },
};

const getGameIcon = vi.fn<(name: string) => Promise<{ data: string; mime: string } | null>>();

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  (window as unknown as { backspace: unknown }).backspace = { getGameIcon };
  getGameIcon.mockReset();
  mockUpload.mockReset();
  useActivityStore.getState().reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { backspace: unknown }).backspace;
});

describe('activityStore game icon enrichment', () => {
  it('sends a game activity unchanged when no desktop bridge exists', async () => {
    delete (window as unknown as { backspace: unknown }).backspace;
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWsSendAll).toHaveBeenCalledWith({
      type: 'activity_update',
      activities: [GAME_ACTIVITY],
    });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('uploads the extracted icon and attaches the instance url', async () => {
    getGameIcon.mockResolvedValue({ data: 'aWNjb24=', mime: 'image/png' });
    mockUpload.mockResolvedValue({ id: 'abc', url: 'https://chat.test/api/game-icons/assets/abc.webp' });

    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(getGameIcon).toHaveBeenCalledWith('Minecraft');
    expect(mockUpload).toHaveBeenCalledWith({ image: 'aWNjb24=' });
    expect(mockWsSendAll).toHaveBeenCalledWith({
      type: 'activity_update',
      activities: [{ ...GAME_ACTIVITY, assets: { largeImage: 'https://chat.test/api/game-icons/assets/abc.webp' } }],
    });
    // The URL is cached: the next push sends it without another upload
    mockWsSendAll.mockClear();
    getGameIcon.mockClear();
    mockUpload.mockClear();
    useActivityStore.getState().pushActivities([{ ...GAME_ACTIVITY, details: 'Building' }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getGameIcon).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockWsSendAll).toHaveBeenCalledWith({
      type: 'activity_update',
      activities: [{ ...GAME_ACTIVITY, details: 'Building', assets: { largeImage: 'https://chat.test/api/game-icons/assets/abc.webp' } }],
    });
  });

  it('attaches a cached url without contacting the desktop or the instance', async () => {
    localStorage.setItem('backspace_game_icons', JSON.stringify({ Minecraft: 'https://chat.test/api/game-icons/assets/cached.webp' }));
    localStorage.setItem('backspace_game_icons_seen', JSON.stringify({ Minecraft: Date.now() }));
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getGameIcon).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockWsSendAll).toHaveBeenCalledWith({
      type: 'activity_update',
      activities: [{ ...GAME_ACTIVITY, assets: { largeImage: 'https://chat.test/api/game-icons/assets/cached.webp' } }],
    });
  });

  it('never touches an activity that already has art, or a custom status', async () => {
    const withArt: Activity = { ...GAME_ACTIVITY, name: 'Fancy Game', assets: { largeImage: 'https://chat.test/api/game-icons/assets/x.webp' } };
    const custom: Activity = { type: 'custom', name: 'just chilling' };
    useActivityStore.getState().pushActivities([withArt, custom]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getGameIcon).not.toHaveBeenCalled();
    expect(mockWsSendAll).toHaveBeenCalledWith({ type: 'activity_update', activities: [withArt, custom] });
  });

  it('sends without an icon when extraction finds nothing, and does not hammer the bridge every push', async () => {
    getGameIcon.mockResolvedValue(null);
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWsSendAll).toHaveBeenCalledWith({ type: 'activity_update', activities: [GAME_ACTIVITY] });

    // The miss is remembered: the next push does not ask again right away
    mockWsSendAll.mockClear();
    getGameIcon.mockClear();
    useActivityStore.getState().pushActivities([{ ...GAME_ACTIVITY, details: 'Mining' }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getGameIcon).not.toHaveBeenCalled();
    expect(mockWsSendAll).toHaveBeenCalledWith({ type: 'activity_update', activities: [{ ...GAME_ACTIVITY, details: 'Mining' }] });
  });

  it('lets a newer push supersede one that is still enriching', async () => {
    let releaseUpload: (value: { id: string; url: string }) => void = () => {};
    getGameIcon.mockResolvedValue({ data: 'aWNjb24=', mime: 'image/png' });
    mockUpload.mockImplementation(() => new Promise((resolve) => { releaseUpload = resolve; }));

    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    await vi.advanceTimersByTimeAsync(5000); // debounce fires, upload hangs
    expect(mockWsSendAll).not.toHaveBeenCalled();

    // A newer activity arrives while the first upload is in flight; the
    // first upload's timeout lapses on the way (it caches a miss), so the
    // newer push sends without waiting for it — never the stale list.
    const newer: Activity = { ...GAME_ACTIVITY, details: 'Newer' };
    useActivityStore.getState().pushActivities([newer]);
    await vi.advanceTimersByTimeAsync(5000);

    const calls = mockWsSendAll.mock.calls as Array<[{ type: string; activities: Activity[] }]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0].activities[0]?.details).toBe('Newer');
    // The stale activity list never reaches the wire
    expect(calls.some(([{ activities }]) => activities[0]?.details !== 'Newer')).toBe(false);

    // The late upload resolution must not produce a second, stale send
    releaseUpload({ id: 'abc', url: 'https://chat.test/api/game-icons/assets/abc.webp' });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockWsSendAll).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for a stuck icon pipeline after the timeout', async () => {
    getGameIcon.mockImplementation(() => new Promise(() => { /* never settles */ }));
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    await vi.advanceTimersByTimeAsync(5000 + 4000);
    expect(mockWsSendAll).toHaveBeenCalledWith({ type: 'activity_update', activities: [GAME_ACTIVITY] });
  });
  it('sends nothing for a push whose icon was still uploading when sharing was switched off', async () => {
    getGameIcon.mockResolvedValue({ data: 'aWNjb24=', mime: 'image/png' });
    let finishUpload: (value: { id: string; url: string }) => void = () => undefined;
    mockUpload.mockReturnValue(new Promise((resolve) => { finishUpload = resolve; }));

    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    await vi.advanceTimersByTimeAsync(5000); // the debounce fired, the upload is in flight
    useActivityStore.getState().setShowActivity(false);
    mockWsSendAll.mockClear();

    finishUpload({ id: 'abc', url: 'https://chat.test/api/game-icons/assets/abc.webp' });
    await vi.advanceTimersByTimeAsync(10);

    expect(mockWsSendAll).not.toHaveBeenCalled();
    expect(useActivityStore.getState().myActivities).toBeNull();
  });
});
