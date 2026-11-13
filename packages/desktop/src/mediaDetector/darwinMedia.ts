import { systemPreferences } from 'electron';
import type { MediaTrackInfo } from './types';
import { sanitizeTrackUrl } from './trackUrl';

export type MediaChangeCallback = (track: MediaTrackInfo | null) => void;

interface SpotifyNotificationUserInfo {
  'Player State'?: string;
  Name?: string;
  Artist?: string;
  Album?: string;
  'Track ID'?: string;
  Duration?: number;
  'Playback Position'?: number;
}

interface AppleMusicNotificationUserInfo {
  'Player State'?: string;
  Name?: string;
  Artist?: string;
  Album?: string;
  'Total Time'?: number;
  'Player Position'?: number;
}

let spotifySubId: number | null = null;
let appleMusicSubId: number | null = null;
let currentTrack: MediaTrackInfo | null = null;
let activeCallback: MediaChangeCallback | null = null;

function emitUpdate(track: MediaTrackInfo | null): void {
  currentTrack = track;
  activeCallback?.(track);
}

export function startDarwinMedia(callback: MediaChangeCallback): void {
  activeCallback = callback;

  if (process.platform !== 'darwin' || !systemPreferences?.subscribeNotification) {
    return;
  }

  // Spotify
  try {
    spotifySubId = systemPreferences.subscribeNotification(
      'com.spotify.client.PlaybackStateChanged',
      (_event, userInfo: SpotifyNotificationUserInfo) => {
        const state = userInfo['Player State'];
        if (state !== 'Playing') {
          if (currentTrack?.player === 'Spotify') {
            emitUpdate(null);
          }
          return;
        }

        const title = userInfo.Name || '';
        const artist = userInfo.Artist || '';
        const album = userInfo.Album;
        const durationSec = typeof userInfo.Duration === 'number' ? userInfo.Duration : undefined;
        const durationMs = durationSec ? Math.round(durationSec * 1000) : undefined;
        const positionSec = typeof userInfo['Playback Position'] === 'number' ? userInfo['Playback Position'] : undefined;
        const positionMs = positionSec ? Math.round(positionSec * 1000) : undefined;
        const rawUrl = userInfo['Track ID'];

        if (!title) {
          emitUpdate(null);
          return;
        }

        emitUpdate({
          title,
          artist,
          album,
          durationMs,
          positionMs,
          isPlaying: true,
          player: 'Spotify',
          sourceUrl: sanitizeTrackUrl(rawUrl),
        });
      },
    );
  } catch (err) {
    console.warn('[MediaDetector] Failed to subscribe to Spotify notifications:', err);
  }

  // Apple Music
  try {
    appleMusicSubId = systemPreferences.subscribeNotification(
      'com.apple.Music.playerInfo',
      (_event, userInfo: AppleMusicNotificationUserInfo) => {
        const state = userInfo['Player State'];
        if (state !== 'Playing') {
          if (currentTrack?.player === 'Apple Music') {
            emitUpdate(null);
          }
          return;
        }

        const title = userInfo.Name || '';
        const artist = userInfo.Artist || '';
        const album = userInfo.Album;
        const totalTime = typeof userInfo['Total Time'] === 'number' ? userInfo['Total Time'] : undefined;
        const positionSec = typeof userInfo['Player Position'] === 'number' ? userInfo['Player Position'] : undefined;
        const positionMs = positionSec ? Math.round(positionSec * 1000) : undefined;

        if (!title) {
          emitUpdate(null);
          return;
        }

        emitUpdate({
          title,
          artist,
          album,
          durationMs: totalTime,
          positionMs,
          isPlaying: true,
          player: 'Apple Music',
        });
      },
    );
  } catch (err) {
    console.warn('[MediaDetector] Failed to subscribe to Apple Music notifications:', err);
  }
}

export function stopDarwinMedia(): void {
  if (process.platform === 'darwin' && systemPreferences?.unsubscribeNotification) {
    if (spotifySubId !== null) {
      try { systemPreferences.unsubscribeNotification(spotifySubId); } catch {}
      spotifySubId = null;
    }
    if (appleMusicSubId !== null) {
      try { systemPreferences.unsubscribeNotification(appleMusicSubId); } catch {}
      appleMusicSubId = null;
    }
  }
  currentTrack = null;
  activeCallback = null;
}
