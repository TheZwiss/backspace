export interface ParsedTrack {
  title: string;
  artist: string;
}

const SYSTEM_IDLE_TITLES = new Set(['n/a', '暂缺', '-', '--', 'none', 'null', 'undefined', '']);

const IDLE_TITLES: Record<string, string[]> = {
  cloudmusic: ['网易云音乐', 'netease cloud music', '桌面歌词'],
  qqmusic: ['qq音乐', 'qqmusic', '桌面歌词', 'qq音乐，听我想听的歌', '听我想听的歌', 'qq音乐 - 听我想听的歌'],
  spotify: ['spotify', 'spotify free', 'spotify premium'],
  yandexmusic: ['яндекс музыка', 'yandex music', 'yandex.music'],
  kugou: ['酷狗音乐', 'kugou music', 'kugou', '桌面歌词', 'hello kugou'],
  kuwo: ['酷我音乐', 'kuwo music', 'kwmusic', '桌面歌词', '好音质 用酷我'],
  foobar2000: ['foobar2000'],
  aimp: ['aimp'],
  musicbee: ['musicbee'],
};

/**
 * Checks if a window title is simply the idle app name or a system placeholder.
 */
export function isAppIdleTitle(appKey: string, rawTitle: string): boolean {
  const normalized = rawTitle.trim().toLowerCase();
  if (!normalized || SYSTEM_IDLE_TITLES.has(normalized)) return true;

  const idleList = IDLE_TITLES[appKey.toLowerCase()];
  if (idleList && idleList.some((idle) => normalized === idle)) {
    return true;
  }

  // Spotify idle title prefixes
  if (appKey.toLowerCase() === 'spotify') {
    if (normalized.startsWith('spotify free') || normalized.startsWith('spotify premium')) {
      return true;
    }
  }

  return false;
}

const SPACED_SEPARATORS = [' - ', ' – ', ' — ', ' － '];
const UNSPACED_SEPARATORS = ['—', '－', '–'];

function findFirstSeparator(str: string): { index: number; length: number } | null {
  let bestIdx = -1;
  let bestLen = 0;
  for (const sep of SPACED_SEPARATORS) {
    const idx = str.indexOf(sep);
    if (idx > 0 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestLen = sep.length;
    }
  }
  if (bestIdx > 0) return { index: bestIdx, length: bestLen };

  for (const sep of UNSPACED_SEPARATORS) {
    const idx = str.indexOf(sep);
    if (idx > 0 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestLen = sep.length;
    }
  }
  if (bestIdx > 0) return { index: bestIdx, length: bestLen };

  return null;
}

function findLastSeparator(str: string): { index: number; length: number } | null {
  let bestIdx = -1;
  let bestLen = 0;
  for (const sep of SPACED_SEPARATORS) {
    const idx = str.lastIndexOf(sep);
    if (idx > bestIdx) {
      bestIdx = idx;
      bestLen = sep.length;
    }
  }
  if (bestIdx > 0) return { index: bestIdx, length: bestLen };

  for (const sep of UNSPACED_SEPARATORS) {
    const idx = str.lastIndexOf(sep);
    if (idx > bestIdx) {
      bestIdx = idx;
      bestLen = sep.length;
    }
  }
  if (bestIdx > 0) return { index: bestIdx, length: bestLen };

  return null;
}

/**
 * Parses window title into track title and artist based on player conventions.
 */
export function parsePlayerWindowTitle(appKey: string, rawTitle: string): ParsedTrack | null {
  const key = appKey.toLowerCase();
  let title = rawTitle.trim();

  if (isAppIdleTitle(key, title)) {
    return null;
  }

  // Strip player prefix or suffix if embedded in title
  if (key === 'cloudmusic') {
    title = title.replace(/^网易云音乐\s*[-–—－]\s*/i, '').replace(/\s*[-–—－]\s*网易云音乐$/i, '').trim();
  } else if (key === 'qqmusic') {
    title = title.replace(/^qq音乐\s*[-–—－]\s*/i, '').replace(/\s*[-–—－]\s*qq音乐$/i, '').trim();
  } else if (key === 'kugou') {
    title = title.replace(/^酷狗音乐\s*[-–—－]\s*/i, '').replace(/\s*[-–—－]\s*酷狗音乐$/i, '').trim();
  } else if (key === 'kuwo') {
    title = title.replace(/^酷我音乐\s*[-–—－]\s*/i, '').replace(/\s*[-–—－]\s*酷我音乐$/i, '').trim();
  } else if (key === 'yandexmusic') {
    title = title.replace(/\s*[-–—－]\s*Яндекс Музыка$/i, '').replace(/\s*[-–—－]\s*Yandex Music$/i, '').trim();
  } else if (key === 'foobar2000') {
    title = title.replace(/^\[foobar2000\]\s*[-–—－]\s*/i, '').replace(/\s*\[foobar2000\]$/i, '').trim();
  }

  // Format: "Artist - Title" (Spotify, KuGou, AIMP, MusicBee)
  if (key === 'spotify' || key === 'kugou' || key === 'aimp' || key === 'musicbee') {
    const sep = findFirstSeparator(title);
    if (sep) {
      const artist = title.substring(0, sep.index).trim();
      const songTitle = title.substring(sep.index + sep.length).trim();
      if (artist && songTitle) {
        return { artist, title: songTitle };
      }
    }
    return { title, artist: '' };
  }

  // Format: "Title - Artist" (NetEase Cloud Music, QQ Music, Kuwo, Yandex Music)
  const sep = findLastSeparator(title);
  if (sep) {
    const songTitle = title.substring(0, sep.index).trim();
    const artist = title.substring(sep.index + sep.length).trim();
    if (songTitle && artist) {
      return { title: songTitle, artist };
    }
  }

  return { title, artist: '' };
}
