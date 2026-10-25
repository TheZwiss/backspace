import type { MediaTrackInfo } from './types';
import { sanitizeTrackUrl } from './trackUrl';
import type { MediaChangeCallback } from './darwinMedia';

let activeCallback: MediaChangeCallback | null = null;
let currentTrack: MediaTrackInfo | null = null;
let bus: unknown = null;
let pollTimer: NodeJS.Timeout | null = null;

const PLAYER_NAME_MAP: Record<string, string> = {
  spotify: 'Spotify',
  'netease-cloud-music': '网易云音乐',
  qqmusic: 'QQ音乐',
  rhythmbox: 'Rhythmbox',
  vlc: 'VLC',
  cavalier: 'Cavalier',
  audacious: 'Audacious',
  amberol: 'Amberol',
  strawberry: 'Strawberry',
  clementine: 'Clementine',
  elisa: 'Elisa',
};

export function getPlayerDisplayName(busName: string): string {
  const sub = busName.replace(/^org\.mpris\.MediaPlayer2\./, '').toLowerCase();
  return PLAYER_NAME_MAP[sub] ?? (sub.charAt(0).toUpperCase() + sub.slice(1));
}

export function parseMprisMetadata(metadata: Record<string, unknown>, player: string): MediaTrackInfo | null {
  const getVal = (key: string): unknown => {
    const raw = metadata[key];
    if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
      return (raw as Record<string, unknown>).value;
    }
    return raw;
  };

  const titleVal = getVal('xesam:title');
  const title = typeof titleVal === 'string' ? titleVal.trim() : '';
  if (!title) return null;

  const artistVal = getVal('xesam:artist');
  let artist = '';
  if (Array.isArray(artistVal)) {
    artist = artistVal.filter((a) => typeof a === 'string').join(', ').trim();
  } else if (typeof artistVal === 'string') {
    artist = artistVal.trim();
  }

  const albumVal = getVal('xesam:album');
  const album = typeof albumVal === 'string' ? albumVal.trim() : undefined;

  const lengthVal = getVal('mpris:length');
  let durationMs: number | undefined;
  if (typeof lengthVal === 'number' || typeof lengthVal === 'bigint') {
    // MPRIS length is in microseconds
    durationMs = Math.round(Number(lengthVal) / 1000);
  }

  const artUrlVal = getVal('mpris:artUrl');
  let artUrl: string | undefined;
  if (typeof artUrlVal === 'string' && artUrlVal.startsWith('https://')) {
    artUrl = artUrlVal;
  }

  const urlVal = getVal('xesam:url');
  const sourceUrl = typeof urlVal === 'string' ? sanitizeTrackUrl(urlVal) : undefined;

  return {
    title,
    artist,
    album,
    artUrl,
    durationMs,
    isPlaying: true,
    player,
    sourceUrl,
  };
}

export function startLinuxMedia(callback: MediaChangeCallback): void {
  activeCallback = callback;
  if (process.platform !== 'linux') return;

  try {
    // Dynamic import dbus-next to avoid loading native dbus in non-linux environments
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbus = require('dbus-next');
    bus = dbus.sessionBus();

    const checkMpris = async () => {
      try {
        const sessionBus = bus as {
          invoke: (options: {
            destination: string;
            path: string;
            interface: string;
            member: string;
            signature?: string;
            body?: unknown[];
          }) => Promise<{ body: unknown[] }>;
        };

        const namesRes = await sessionBus.invoke({
          destination: 'org.freedesktop.DBus',
          path: '/org/freedesktop/DBus',
          interface: 'org.freedesktop.DBus',
          member: 'ListNames',
        });

        const names = (namesRes.body[0] as string[]) || [];
        const mprisNames = names.filter((n) => n.startsWith('org.mpris.MediaPlayer2.'));

        for (const name of mprisNames) {
          try {
            const statusRes = await sessionBus.invoke({
              destination: name,
              path: '/org/mpris/MediaPlayer2',
              interface: 'org.freedesktop.DBus.Properties',
              member: 'Get',
              signature: 'ss',
              body: ['org.mpris.MediaPlayer2.Player', 'PlaybackStatus'],
            });

            const status = (statusRes.body[0] as { value?: string })?.value;
            if (status === 'Playing') {
              const metaRes = await sessionBus.invoke({
                destination: name,
                path: '/org/mpris/MediaPlayer2',
                interface: 'org.freedesktop.DBus.Properties',
                member: 'Get',
                signature: 'ss',
                body: ['org.mpris.MediaPlayer2.Player', 'Metadata'],
              });

              const metaDict = (metaRes.body[0] as { value?: Record<string, unknown> })?.value || {};
              const parsed = parseMprisMetadata(metaDict, getPlayerDisplayName(name));
              if (parsed) {
                if (
                  !currentTrack ||
                  currentTrack.title !== parsed.title ||
                  currentTrack.artist !== parsed.artist ||
                  currentTrack.player !== parsed.player
                ) {
                  currentTrack = parsed;
                  activeCallback?.(currentTrack);
                }
                return;
              }
            }
          } catch {
            // Player may have disconnected or not support Player interface
          }
        }

        if (currentTrack !== null) {
          currentTrack = null;
          activeCallback?.(null);
        }
      } catch {
        // D-Bus query error
      }
    };

    checkMpris();
    pollTimer = setInterval(checkMpris, 5000);
  } catch (err) {
    console.warn('[MediaDetector] dbus-next initialization skipped or failed:', err);
  }
}

export function stopLinuxMedia(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (bus) {
    try {
      (bus as { disconnect?: () => void }).disconnect?.();
    } catch {}
    bus = null;
  }
  currentTrack = null;
  activeCallback = null;
}
