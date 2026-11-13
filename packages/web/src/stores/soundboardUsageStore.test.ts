import { beforeEach, describe, expect, it } from 'vitest';
import { useSoundboardUsageStore } from './soundboardUsageStore';

describe('soundboard usage', () => {
  beforeEach(() => useSoundboardUsageStore.setState({ counts: {} }));
  it('tracks successful plays independently for each account and instance', () => {
    const record = useSoundboardUsageStore.getState().recordPlay;
    record('one', 'user', 'sound');
    record('one', 'user', 'sound');
    record('two', 'user', 'sound');
    record('one', 'other', 'sound');
    expect(useSoundboardUsageStore.getState().counts).toEqual({
      '["one","user"]': { sound: 2 },
      '["two","user"]': { sound: 1 },
      '["one","other"]': { sound: 1 },
    });
  });
});
