import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock useWebSocket before importing activityStore
const mockWsSend = vi.fn();
const mockWsSendAll = vi.fn();
vi.mock('../hooks/useWebSocket', () => ({
  wsSend: (...args: unknown[]) => mockWsSend(...args),
  wsSendAll: (...args: unknown[]) => mockWsSendAll(...args),
}));

import { activitiesFor, useActivityStore } from './activityStore';
import type { Activity } from '@backspace/shared';

const GAME_ACTIVITY: Activity = {
  type: 'playing',
  name: 'Minecraft',
  timestamps: { start: Date.now() },
};

beforeEach(() => {
  vi.clearAllMocks();
  useActivityStore.getState().reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('activityStore fan-out', () => {
  it('pushActivities caches myActivities immediately before debounce', () => {
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);

    // myActivities should be set immediately (before the 5s debounce)
    expect(useActivityStore.getState().myActivities).toEqual([GAME_ACTIVITY]);

    // wsSendAll should NOT have been called yet (debounce hasn't fired)
    expect(mockWsSendAll).not.toHaveBeenCalled();
  });

  it('pushActivities calls wsSendAll (not wsSend) after debounce', () => {
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    vi.advanceTimersByTime(5000);

    expect(mockWsSendAll).toHaveBeenCalledWith({
      type: 'activity_update',
      activities: [GAME_ACTIVITY],
    });
    expect(mockWsSend).not.toHaveBeenCalled();
  });

  it('pushActivities with empty list calls wsSendAll immediately without waiting for debounce', () => {
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    vi.advanceTimersByTime(5000);
    mockWsSendAll.mockClear();

    useActivityStore.getState().pushActivities([]);
    expect(mockWsSendAll).toHaveBeenCalledWith({
      type: 'activity_update',
      activities: [],
    });
    expect(useActivityStore.getState().myActivities).toEqual([]);
  });

  it('setShowActivity(false) fans out empty activities via wsSendAll and clears myActivities', () => {
    // First set some activities
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    expect(useActivityStore.getState().myActivities).toEqual([GAME_ACTIVITY]);

    // Now disable
    useActivityStore.getState().setShowActivity(false);

    expect(mockWsSendAll).toHaveBeenCalledWith({
      type: 'activity_update',
      activities: [],
    });
    expect(useActivityStore.getState().myActivities).toBeNull();
  });

  it('reset clears myActivities', () => {
    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    expect(useActivityStore.getState().myActivities).toEqual([GAME_ACTIVITY]);

    useActivityStore.getState().reset();
    expect(useActivityStore.getState().myActivities).toBeNull();
  });

  it('pushActivities does nothing when showActivity is false', () => {
    useActivityStore.getState().setShowActivity(false);
    vi.clearAllMocks();

    useActivityStore.getState().pushActivities([GAME_ACTIVITY]);
    expect(useActivityStore.getState().myActivities).toBeNull();

    vi.advanceTimersByTime(5000);
    expect(mockWsSendAll).not.toHaveBeenCalled();
  });

  it('anchors received media progress on the local clock', () => {
    vi.setSystemTime(100_000);
    useActivityStore.getState().setUserActivities({ id: 'friend' }, '', [{
      type: 'watching',
      name: 'Video',
      timestamps: { start: 999_999_999, end: 1_000_059_999 },
      playback: { positionMs: 15_000, durationMs: 60_000 },
    }]);

    const [activity] = activitiesFor(
      useActivityStore.getState().userActivities,
      { id: 'friend' },
      '',
    );
    expect(activity.timestamps).toEqual({ start: 85_000, end: 145_000 });
  });

  it('refreshes the transport position when the debounced send fires', () => {
    vi.setSystemTime(100_000);
    useActivityStore.getState().pushActivities([{
      type: 'watching',
      name: 'Video',
      timestamps: { start: 90_000, end: 150_000 },
      playback: { positionMs: 10_000, durationMs: 60_000 },
    }]);

    vi.advanceTimersByTime(500);

    expect(mockWsSendAll).toHaveBeenCalledWith({
      type: 'activity_update',
      activities: [{
        type: 'watching',
        name: 'Video',
        timestamps: { start: 90_000, end: 150_000 },
        playback: { positionMs: 10_500, durationMs: 60_000 },
      }],
    });
  });

  it('does not restart an already-anchored activity when republishing', () => {
    vi.setSystemTime(100_000);
    useActivityStore.getState().pushActivities([{
      type: 'watching',
      name: 'Video',
      timestamps: { start: 999_999_999, end: 1_000_059_999 },
      playback: { positionMs: 10_000, durationMs: 60_000 },
    }]);

    vi.advanceTimersByTime(1_000);
    mockWsSendAll.mockClear();
    useActivityStore.getState().republish();
    vi.advanceTimersByTime(500);

    expect(mockWsSendAll).toHaveBeenCalledWith({
      type: 'activity_update',
      activities: [{
        type: 'watching',
        name: 'Video',
        timestamps: { start: 90_000, end: 150_000 },
        playback: { positionMs: 11_500, durationMs: 60_000 },
      }],
    });
  });

  it('keeps a stable start when subsequent remote updates repeat zero position (Chrome SMTC)', () => {
    vi.setSystemTime(100_000);
    // Initial sync
    useActivityStore.getState().setUserActivities({ id: 'friend' }, '', [{
      type: 'watching',
      name: 'Chrome Stream',
      timestamps: { start: 100_000, end: 160_000 },
      playback: { positionMs: 0, durationMs: 60_000 },
    }]);

    const [first] = activitiesFor(
      useActivityStore.getState().userActivities,
      { id: 'friend' },
      '',
    );
    expect(first.timestamps?.start).toBe(100_000);

    // 10 seconds later, another presence update arrives with positionMs: 0 (typical Chrome SMTC snapshot)
    vi.setSystemTime(110_000);
    useActivityStore.getState().setUserActivities({ id: 'friend' }, '', [{
      type: 'watching',
      name: 'Chrome Stream',
      timestamps: { start: 110_000, end: 170_000 },
      playback: { positionMs: 0, durationMs: 60_000 },
    }]);

    const [second] = activitiesFor(
      useActivityStore.getState().userActivities,
      { id: 'friend' },
      '',
    );
    // Must preserve original start, not reset to current clock (110_000)
    expect(second.timestamps?.start).toBe(100_000);
    expect(second.timestamps?.end).toBe(160_000);
    expect(second.playback?.positionMs).toBe(10_000);
  });

  it('resyncs start when incoming playback position jumps significantly (seek)', () => {
    vi.setSystemTime(100_000);
    useActivityStore.getState().setUserActivities({ id: 'friend' }, '', [{
      type: 'watching',
      name: 'Movie',
      timestamps: { start: 100_000, end: 200_000 },
      playback: { positionMs: 0, durationMs: 100_000 },
    }]);

    // 5 seconds later, user jumped to 40_000 ms
    vi.setSystemTime(105_000);
    useActivityStore.getState().setUserActivities({ id: 'friend' }, '', [{
      type: 'watching',
      name: 'Movie',
      timestamps: { start: 65_000, end: 165_000 },
      playback: { positionMs: 40_000, durationMs: 100_000 },
    }]);

    const [activity] = activitiesFor(
      useActivityStore.getState().userActivities,
      { id: 'friend' },
      '',
    );
    // 105_000 - 40_000 = 65_000
    expect(activity.timestamps?.start).toBe(65_000);
    expect(activity.playback?.positionMs).toBe(40_000);
  });

  it('advances playback position for music without durationMs (e.g. NetEase Cloud Music)', () => {
    vi.setSystemTime(100_000);
    useActivityStore.getState().setUserActivities({ id: 'friend' }, '', [{
      type: 'listening',
      name: '晴天',
      timestamps: { start: 90_000 },
      playback: { positionMs: 10_000 },
    }]);

    // 10 seconds later, refresh occurs without a durationMs
    vi.setSystemTime(110_000);
    // Subsequent push or anchor preserves timeline and advances position
    useActivityStore.getState().setUserActivities({ id: 'friend' }, '', [{
      type: 'listening',
      name: '晴天',
      timestamps: { start: 90_000 },
      playback: { positionMs: 20_000 },
    }]);

    const [updated] = activitiesFor(
      useActivityStore.getState().userActivities,
      { id: 'friend' },
      '',
    );
    expect(updated.timestamps?.start).toBe(90_000);
    expect(updated.playback?.positionMs).toBe(20_000);
  });
});
