import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock useWebSocket before importing activityStore
const mockWsSend = vi.fn();
const mockWsSendAll = vi.fn();
vi.mock('../hooks/useWebSocket', () => ({
  wsSend: (...args: unknown[]) => mockWsSend(...args),
  wsSendAll: (...args: unknown[]) => mockWsSendAll(...args),
}));

import { useActivityStore } from './activityStore';
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
});
