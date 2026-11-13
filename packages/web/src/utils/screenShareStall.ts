/**
 * Decisions for recovering a screen share the encoder shrank and never grew
 * back. WebRTC scales the picture down when the uplink estimate dips and climbs
 * back slowly, and with `maintain-framerate` it can stay tiny (268x146) long
 * after the network recovered. Pure, so it is testable without a room; the
 * monitor that feeds it is in `screenShareRecovery.ts`.
 */

export interface ScreenShareStallSample {
  /** Height of the frames the encoder is producing. */
  encodedHeight: number;
  /** Height of the captured source. */
  captureHeight: number;
  /** `qualityLimitationReason` of the outbound stream. */
  limitation: string | null;
  /** The congestion controller's uplink estimate, null when unknown. */
  availableBitrate: number | null;
  /** The bitrate ceiling this share is allowed. */
  targetBitrate: number;
}

/** Encoded height below this share of the capture height counts as shrunk. */
export const STALL_HEIGHT_RATIO = 0.6;
/** The network must cover this share of the target for the shrink to be a fault. */
export const STALL_HEADROOM_RATIO = 0.75;

/**
 * True when the picture is small although nothing explains it. A CPU limit, or
 * an uplink estimate below what the target needs, are honest reasons to be
 * small and are left alone; an unknown estimate is not evidence of a fault.
 */
export function isScreenShareShrunk(sample: ScreenShareStallSample): boolean {
  if (sample.captureHeight <= 0 || sample.encodedHeight <= 0) return false;
  if (sample.encodedHeight >= sample.captureHeight * STALL_HEIGHT_RATIO) return false;
  if (sample.limitation === 'cpu') return false;
  if (sample.availableBitrate == null) return false;
  return sample.availableBitrate >= sample.targetBitrate * STALL_HEADROOM_RATIO;
}

export type RecoveryAction = 'none' | 'reapply' | 'republish';

export interface RecoveryState {
  /** Consecutive samples that read as shrunk. */
  shrunkSamples: number;
  /** Samples since the last action, so a fix gets time to take effect. */
  sinceAction: number;
  reapplied: boolean;
  republishes: number;
}

export const RECOVERY_SAMPLE_MS = 3000;
/** Shrunk samples in a row before acting: 4 x 3 s = 12 s. */
export const RECOVERY_SHRUNK_SAMPLES = 4;
/** Samples to wait after an action before judging it: 5 x 3 s = 15 s. */
export const RECOVERY_SETTLE_SAMPLES = 5;
export const RECOVERY_MAX_REPUBLISHES = 2;

export function initialRecoveryState(): RecoveryState {
  return { shrunkSamples: 0, sinceAction: RECOVERY_SETTLE_SAMPLES, reapplied: false, republishes: 0 };
}

/**
 * Advance the recovery by one sample and say what to do. First a cheap
 * re-assertion of the sender parameters; if the picture is still small after it
 * had time to work, a republish of the same track, at most twice per share so a
 * network that truly cannot carry the share does not loop.
 */
export function stepRecovery(state: RecoveryState, shrunk: boolean): RecoveryAction {
  state.sinceAction += 1;
  if (!shrunk) {
    state.shrunkSamples = 0;
    return 'none';
  }
  state.shrunkSamples += 1;
  if (state.shrunkSamples < RECOVERY_SHRUNK_SAMPLES) return 'none';
  if (state.sinceAction < RECOVERY_SETTLE_SAMPLES) return 'none';

  state.shrunkSamples = 0;
  if (!state.reapplied) {
    state.reapplied = true;
    state.sinceAction = 0;
    return 'reapply';
  }
  if (state.republishes < RECOVERY_MAX_REPUBLISHES) {
    state.republishes += 1;
    state.sinceAction = 0;
    return 'republish';
  }
  return 'none';
}
