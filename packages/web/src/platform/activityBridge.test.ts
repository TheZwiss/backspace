import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('../stores/activityStore', () => ({
  useActivityStore: { getState: () => ({ pushActivities: push }) },
}));

import { fetchCurrentActivities, initActivityBridge, teardownActivityBridge, toActivityList } from './activityBridge';

const game = (name: string) => ({ type: 'playing', name });

function setBridge(bridge: Record<string, unknown> | undefined) {
  (window as unknown as { backspace?: unknown }).backspace = bridge;
}

describe('toActivityList', () => {
  it('accepts a list, one activity (older desktops) or nothing', () => {
    expect(toActivityList([game('A'), game('B')])).toHaveLength(2);
    expect(toActivityList(game('A'))).toEqual([game('A')]);
    expect(toActivityList(null)).toEqual([]);
    expect(toActivityList(undefined)).toEqual([]);
    expect(toActivityList([null, 'x', game('A')])).toEqual([game('A')]);
  });
});

describe('activity bridge', () => {
  beforeEach(() => {
    push.mockClear();
  });
  afterEach(() => {
    teardownActivityBridge();
    setBridge(undefined);
  });

  it('uses the list channels of a desktop that has them, and only those', async () => {
    let listener: ((value: unknown) => void) | null = null;
    const single = vi.fn(() => () => {});
    setBridge({
      onActivityDetected: single,
      onActivitiesDetected: (cb: (value: unknown) => void) => { listener = cb; return () => {}; },
      getCurrentActivities: () => Promise.resolve([game('A'), game('B')]),
      getCurrentActivity: () => Promise.resolve(game('A')),
    });
    initActivityBridge();
    await Promise.resolve(); await Promise.resolve();
    expect(single).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith([game('A'), game('B')]);
    listener!([game('C')]);
    expect(push).toHaveBeenLastCalledWith([game('C')]);
    listener!([]);
    expect(push).toHaveBeenLastCalledWith([]);
  });

  it('falls back to the single-activity channels of an older desktop', async () => {
    let listener: ((value: unknown) => void) | null = null;
    setBridge({
      onActivityDetected: (cb: (value: unknown) => void) => { listener = cb; return () => {}; },
      getCurrentActivity: () => Promise.resolve(game('A')),
    });
    initActivityBridge();
    await Promise.resolve(); await Promise.resolve();
    expect(push).toHaveBeenCalledWith([game('A')]);
    listener!(null);
    expect(push).toHaveBeenLastCalledWith([]);
    expect(await fetchCurrentActivities()).toEqual([game('A')]);
  });

  it('is quiet in a browser', async () => {
    setBridge(undefined);
    initActivityBridge();
    expect(await fetchCurrentActivities()).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });
});
