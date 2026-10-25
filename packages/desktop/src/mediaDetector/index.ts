import type { MediaActivity, MediaTrackInfo } from './types';
import { startDarwinMedia, stopDarwinMedia } from './darwinMedia';
import {
  startWin32Media,
  stopWin32Media,
  type MediaSetupHint,
  type MediaSetupHintCallback,
} from './win32Media';
import { startLinuxMedia, stopLinuxMedia } from './linuxMpris';

export type { MediaActivity, MediaSetupHint, MediaTrackInfo };

let currentActivity: MediaActivity | null = null;
let changeCallback: ((activity: MediaActivity | null) => void) | null = null;
let isRunning = false;

const TRACK_POSITION_SYNC_TOLERANCE_MS = 1_500;

interface MediaTimeline {
  trackKey: string;
  start: number;
}

let currentTimeline: MediaTimeline | null = null;

function mediaTrackKey(track: MediaTrackInfo): string {
  // SMTC's media type can flip between music and video for one Chrome session.
  // It decides how the activity is rendered, not which timeline is playing.
  return [track.player, track.title, track.artist].join('\0');
}

/**
 * Keep one absolute start timestamp for the current track. SMTC implementations
 * may refresh the same zero-valued timeline repeatedly; re-anchoring on every
 * snapshot makes remote progress restart from zero.
 */
export function nextMediaTimeline(
  previous: MediaTimeline | null,
  track: MediaTrackInfo,
  now: number,
): MediaTimeline {
  const trackKey = mediaTrackKey(track);
  const positionMs = typeof track.positionMs === 'number' && track.positionMs >= 0
    ? track.positionMs
    : undefined;

  if (!previous || previous.trackKey !== trackKey) {
    return {
      trackKey,
      start: now - (positionMs ?? 0),
    };
  }

  const positionChanged =
    positionMs !== undefined &&
    // Chrome can repeatedly report Position=0 for the same playing video.
    // Treat that as a stale SMTC snapshot, not a seek back to the beginning.
    positionMs > 0 &&
    Math.abs(positionMs - (now - previous.start)) > TRACK_POSITION_SYNC_TOLERANCE_MS;

  return {
    trackKey,
    start: positionChanged ? now - positionMs : previous.start,
  };
}

export function convertTrackToActivity(
  track: MediaTrackInfo | null,
  timelineStart?: number,
): MediaActivity | null {
  if (!track || !track.title) return null;

  const now = Date.now();
  let start: number;
  let end: number | undefined;

  // Single-track progress: calculates start timestamp from track's position
  // and end timestamp from duration so clients can render live "01:23 / 03:45" progress.
  if (timelineStart !== undefined) {
    start = timelineStart;
  } else if (typeof track.durationMs === 'number' && track.durationMs > 0) {
    const pos = typeof track.positionMs === 'number' && track.positionMs >= 0 ? track.positionMs : 0;
    start = Math.round(now - pos);
  } else if (typeof track.positionMs === 'number' && track.positionMs >= 0) {
    start = Math.round(now - track.positionMs);
  } else {
    start = now;
  }

  if (typeof track.durationMs === 'number' && track.durationMs > 0) {
    end = Math.round(start + track.durationMs);
  }

  const positionMs = Math.max(0, Math.round(now - start));
  const activityType: 'listening' | 'watching' =
    track.mediaType === 'video' ? 'watching' : 'listening';

  return {
    type: activityType,
    name: track.title.slice(0, 128),
    details: track.artist ? track.artist.slice(0, 128) : undefined,
    state: track.album ? track.album.slice(0, 128) : undefined,
    timestamps: {
      start,
      end,
    },
    // This position does not depend on either device's wall clock. The server
    // advances it while the activity is cached and each client anchors it on
    // receipt, avoiding clock-skew resets and stale ready payloads.
    playback: {
      positionMs: typeof track.durationMs === 'number' && track.durationMs > 0
        ? Math.min(track.durationMs, positionMs)
        : positionMs,
      ...(typeof track.durationMs === 'number' && track.durationMs > 0
        ? { durationMs: track.durationMs }
        : {}),
    },
    assets: {
      largeImage: track.artUrl,
      largeText: track.album ? track.album.slice(0, 128) : undefined,
      smallText: track.player ? track.player.slice(0, 128) : undefined,
    },
    url: track.sourceUrl,
  };
}

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

  if (process.platform === 'darwin') {
    startDarwinMedia(handleTrackChange);
  } else if (process.platform === 'win32') {
    startWin32Media(handleTrackChange, onSetupHint);
  } else if (process.platform === 'linux') {
    startLinuxMedia(handleTrackChange);
  }
}

export function stopMediaDetection(): void {
  if (!isRunning) return;
  isRunning = false;

  if (process.platform === 'darwin') {
    stopDarwinMedia();
  } else if (process.platform === 'win32') {
    stopWin32Media();
  } else if (process.platform === 'linux') {
    stopLinuxMedia();
  }

  currentTimeline = null;
  currentActivity = null;
  changeCallback = null;
}

export function getCurrentMediaActivity(): MediaActivity | null {
  return currentActivity;
}
