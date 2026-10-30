import type { MediaActivity, MediaTrackInfo } from './types';

const TRACK_POSITION_SYNC_TOLERANCE_MS = 1_500;

export interface MediaTimeline {
  trackKey: string;
  start: number;
}

function mediaTrackKey(track: MediaTrackInfo): string {
  return [track.player, track.title, track.artist].join('\0');
}

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
    return { trackKey, start: now - (positionMs ?? 0) };
  }

  const positionChanged =
    positionMs !== undefined &&
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
    timestamps: { start, end },
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
