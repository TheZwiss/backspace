import { describe, it, expect } from 'vitest';
import { projectActivityPlayback, validateActivities } from './presenceEvent.js';

// One rule for a local client's activity_update and a peer's relayed
// presence: an activity the sender accepts must be one every receiver accepts.
describe('validateActivities', () => {
  it('accepts a named activity and trims its name', () => {
    expect(validateActivities([{ type: 'playing', name: '  Factorio ' }])).toEqual([{ type: 'playing', name: 'Factorio' }]);
  });

  it('preserves the absolute media timeline sent by another client', () => {
    expect(validateActivities([{
      type: 'watching',
      name: 'Video',
      timestamps: { start: 1_700_000_000_000, end: 1_700_000_300_000 },
    }])).toEqual([{
      type: 'watching',
      name: 'Video',
      timestamps: { start: 1_700_000_000_000, end: 1_700_000_300_000 },
    }]);
  });

  it('validates clock-independent playback progress and clamps it to the duration', () => {
    expect(validateActivities([{
      type: 'watching',
      name: 'Video',
      playback: { positionMs: 75_000, durationMs: 60_000 },
    }])).toEqual([{
      type: 'watching',
      name: 'Video',
      playback: { positionMs: 60_000, durationMs: 60_000 },
    }]);
  });

  it('ignores malformed playback progress without rejecting the activity', () => {
    expect(validateActivities([{
      type: 'watching',
      name: 'Video',
      playback: { positionMs: -1, durationMs: 60_000 },
    }])).toEqual([{
      type: 'watching',
      name: 'Video',
    }]);
  });

  it('refuses a name that is only whitespace', () => {
    expect(validateActivities([{ type: 'playing', name: '   ' }])).toBeNull();
  });

  it('refuses an empty name', () => {
    expect(validateActivities([{ type: 'playing', name: '' }])).toBeNull();
  });
});

describe('projectActivityPlayback', () => {
  it('advances a cached media position by the time it has been held', () => {
    expect(projectActivityPlayback([{
      type: 'watching',
      name: 'Video',
      playback: { positionMs: 10_000, durationMs: 30_000 },
    }], 5_000)).toEqual([{
      type: 'watching',
      name: 'Video',
      playback: { positionMs: 15_000, durationMs: 30_000 },
    }]);
  });

  it('stops at the duration and leaves non-media activities untouched', () => {
    const playing = { type: 'playing' as const, name: 'Game' };
    expect(projectActivityPlayback([{
      type: 'watching',
      name: 'Video',
      playback: { positionMs: 29_000, durationMs: 30_000 },
    }, playing], 5_000)).toEqual([{
      type: 'watching',
      name: 'Video',
      playback: { positionMs: 30_000, durationMs: 30_000 },
    }, playing]);
  });
});
