import { describe, expect, it } from 'vitest';
import {
  initialRecoveryState,
  isScreenShareShrunk,
  RECOVERY_MAX_REPUBLISHES,
  RECOVERY_SETTLE_SAMPLES,
  RECOVERY_SHRUNK_SAMPLES,
  stepRecovery,
  type RecoveryAction,
  type ScreenShareStallSample,
} from './screenShareStall';

const stuck: ScreenShareStallSample = {
  encodedHeight: 146,
  captureHeight: 1080,
  limitation: 'bandwidth',
  availableBitrate: 8_000_000,
  targetBitrate: 6_000_000,
};

describe('isScreenShareShrunk', () => {
  it('flags a small picture while the network could carry the target', () => {
    expect(isScreenShareShrunk(stuck)).toBe(true);
  });

  it('leaves a full-size picture alone', () => {
    expect(isScreenShareShrunk({ ...stuck, encodedHeight: 1080 })).toBe(false);
    expect(isScreenShareShrunk({ ...stuck, encodedHeight: 720 })).toBe(false);
  });

  it('treats a small picture as honest when the uplink is short', () => {
    expect(isScreenShareShrunk({ ...stuck, availableBitrate: 500_000 })).toBe(false);
  });

  it('treats a CPU limit as honest', () => {
    expect(isScreenShareShrunk({ ...stuck, limitation: 'cpu' })).toBe(false);
  });

  it('does not act on an unknown estimate or unknown sizes', () => {
    expect(isScreenShareShrunk({ ...stuck, availableBitrate: null })).toBe(false);
    expect(isScreenShareShrunk({ ...stuck, captureHeight: 0 })).toBe(false);
    expect(isScreenShareShrunk({ ...stuck, encodedHeight: 0 })).toBe(false);
  });
});

function run(state: ReturnType<typeof initialRecoveryState>, samples: number, shrunk: boolean): RecoveryAction[] {
  return Array.from({ length: samples }, () => stepRecovery(state, shrunk));
}

describe('stepRecovery', () => {
  it('waits for enough shrunk samples in a row before acting', () => {
    const state = initialRecoveryState();
    const actions = run(state, RECOVERY_SHRUNK_SAMPLES, true);
    expect(actions.slice(0, -1).every((a) => a === 'none')).toBe(true);
    expect(actions.at(-1)).toBe('reapply');
  });

  it('resets the count when the picture recovers', () => {
    const state = initialRecoveryState();
    run(state, RECOVERY_SHRUNK_SAMPLES - 1, true);
    expect(stepRecovery(state, false)).toBe('none');
    expect(run(state, RECOVERY_SHRUNK_SAMPLES - 1, true).every((a) => a === 'none')).toBe(true);
  });

  it('republishes only after the reassertion had time and did not help', () => {
    const state = initialRecoveryState();
    expect(run(state, RECOVERY_SHRUNK_SAMPLES, true).at(-1)).toBe('reapply');

    const next = run(state, RECOVERY_SETTLE_SAMPLES + RECOVERY_SHRUNK_SAMPLES, true);
    expect(next.filter((a) => a === 'republish')).toHaveLength(1);
    expect(next.indexOf('republish')).toBeGreaterThanOrEqual(RECOVERY_SETTLE_SAMPLES - 1);
  });

  it('stops after the republish limit so a share the network cannot carry does not loop', () => {
    const state = initialRecoveryState();
    const all = run(state, 200, true);
    expect(all.filter((a) => a === 'reapply')).toHaveLength(1);
    expect(all.filter((a) => a === 'republish')).toHaveLength(RECOVERY_MAX_REPUBLISHES);
  });

  it('does nothing while the picture is fine', () => {
    const state = initialRecoveryState();
    expect(run(state, 50, false).every((a) => a === 'none')).toBe(true);
  });
});
