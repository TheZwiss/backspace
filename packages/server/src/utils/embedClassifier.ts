import type { EmbedType, EmbedProvider } from '@backspace/shared';

export interface EmbedClassification {
  embedType: EmbedType;
  provider: EmbedProvider | null;
  embedUrl: string | null;
  needsMetadataFetch: boolean;
}

function extractYouTubeId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return id || null;
  }

  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const path = url.pathname;

    // /watch?v=ID
    if (path === '/watch') {
      return url.searchParams.get('v');
    }

    // /shorts/ID
    const shortsMatch = path.match(/^\/shorts\/([A-Za-z0-9_-]+)/);
    if (shortsMatch) return shortsMatch[1] ?? null;

    // /embed/ID
    const embedMatch = path.match(/^\/embed\/([A-Za-z0-9_-]+)/);
    if (embedMatch) return embedMatch[1] ?? null;

    // /v/ID (legacy)
    const vMatch = path.match(/^\/v\/([A-Za-z0-9_-]+)/);
    if (vMatch) return vMatch[1] ?? null;
  }

  return null;
}

export function classifyUrl(rawUrl: string): EmbedClassification {
  // Direct media extension checks
  if (/\.(jpg|jpeg|png|gif|webp|avif)(\?.*)?$/i.test(rawUrl)) {
    return { embedType: 'image', provider: null, embedUrl: null, needsMetadataFetch: false };
  }

  if (/\.(mp3|ogg|wav|flac|opus)(\?.*)?$/i.test(rawUrl)) {
    return { embedType: 'audio', provider: null, embedUrl: null, needsMetadataFetch: false };
  }

  if (/\.(mp4|webm|mov)(\?.*)?$/i.test(rawUrl)) {
    return { embedType: 'video', provider: null, embedUrl: null, needsMetadataFetch: false };
  }

  // Provider matching requires a valid URL
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { embedType: 'generic', provider: null, embedUrl: null, needsMetadataFetch: true };
  }

  const host = url.hostname.replace(/^www\./, '');

  // YouTube
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
    const videoId = extractYouTubeId(url);
    if (videoId) {
      return {
        embedType: 'video',
        provider: 'youtube',
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
        needsMetadataFetch: true,
      };
    }
  }

  // Vimeo
  if (host === 'vimeo.com') {
    const match = url.pathname.match(/^\/(\d+)/);
    if (match) {
      return {
        embedType: 'video',
        provider: 'vimeo',
        embedUrl: `https://player.vimeo.com/video/${match[1]}`,
        needsMetadataFetch: true,
      };
    }
  }

  // Spotify
  if (host === 'open.spotify.com') {
    const match = url.pathname.match(/^\/(track|album|playlist)\/([A-Za-z0-9]+)/);
    if (match) {
      const [, type, id] = match;
      return {
        embedType: 'rich',
        provider: 'spotify',
        embedUrl: `https://open.spotify.com/embed/${type}/${id}`,
        needsMetadataFetch: true,
      };
    }
  }

  // Everything else
  return { embedType: 'generic', provider: null, embedUrl: null, needsMetadataFetch: true };
}
