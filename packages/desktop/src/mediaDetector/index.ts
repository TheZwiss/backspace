import type { MediaActivity, MediaTrackInfo } from './types';
import type { MediaSetupHint, MediaSetupHintCallback } from './types';
import { mediaAdapterFor, type MediaAdapter } from './adapter';
import { convertTrackToActivity, nextMediaTimeline, type MediaTimeline } from './core';

export type { MediaActivity, MediaSetupHint, MediaTrackInfo };
export type { MediaSetupHintCallback } from './types';
export { convertTrackToActivity, nextMediaTimeline, type MediaTimeline } from './core';

let currentActivity: MediaActivity | null = null;
let changeCallback: ((activity: MediaActivity | null) => void) | null = null;
let isRunning = false;
let currentTimeline: MediaTimeline | null = null;
let activeAdapter: MediaAdapter | null = null;

function handleTrackChange(track: MediaTrackInfo | null): void {
  if (track && track.title && track.isPlaying) {
    currentTimeline = nextMediaTimeline(currentTimeline, track, Date.now());
    const activity = convertTrackToActivity(track, currentTimeline.start);
    currentActivity = activity;
    changeCallback?.(currentActivity);
  } else {
    currentTimeline = null;
    currentActivity = null;
    changeCallback?.(null);
  }
}

export function startMediaDetection(
  onMediaChange: (activity: MediaActivity | null) => void,
  onSetupHint?: MediaSetupHintCallback,
): void {
  if (isRunning) return;
  isRunning = true;
  changeCallback = onMediaChange;
  activeAdapter = mediaAdapterFor();
  activeAdapter?.start(handleTrackChange, onSetupHint);
}

export function stopMediaDetection(): void {
  if (!isRunning) return;
  isRunning = false;

  activeAdapter?.stop();
  activeAdapter = null;

  currentTimeline = null;
  currentActivity = null;
  changeCallback = null;
}

export function getCurrentMediaActivity(): MediaActivity | null {
  return currentActivity;
}
