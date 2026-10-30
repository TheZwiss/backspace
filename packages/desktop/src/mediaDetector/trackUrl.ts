/**
 * Canonical music URL filter and normalizer.
 * Strips tracking parameters (like Spotify 'si') and browser addresses,
 * keeping only canonical track links for allowed music services.
 *
 * The result is shown as a clickable link on the user's profile, so every
 * branch matches the hostname exactly (or as a true subdomain) and rebuilds
 * the URL from validated parts instead of echoing the input.
 */

/** True when `host` is `domain` itself or a subdomain of it (never a look-alike suffix/prefix). */
function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
const NUMERIC_RE = /^[0-9]+$/;
const SLUG_RE = /^[A-Za-z0-9._~%-]+$/;
const SUBDOMAIN_RE = /^[a-z0-9-]+$/;

export function sanitizeTrackUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl || typeof rawUrl !== 'string') return undefined;

  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;

  // Spotify URI: spotify:track:{id}
  const spotifyUriMatch = trimmed.match(/^spotify:track:([a-zA-Z0-9]+)$/);
  if (spotifyUriMatch?.[1]) {
    return `https://open.spotify.com/track/${spotifyUriMatch[1]}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    // Spotify: open.spotify.com/track/{id}
    if (host === 'open.spotify.com') {
      const match = pathname.match(/^\/track\/([a-zA-Z0-9]+)/);
      if (match?.[1]) return `https://open.spotify.com/track/${match[1]}`;
      return undefined;
    }

    // Apple Music: music.apple.com/{country}/album/{slug}/{id}?i={trackId}
    if (host === 'music.apple.com') {
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length === 0 || !segments.every((s) => SLUG_RE.test(s))) return undefined;
      const base = `https://music.apple.com/${segments.join('/')}`;
      const trackId = parsed.searchParams.get('i');
      if (trackId && NUMERIC_RE.test(trackId)) return `${base}?i=${trackId}`;
      return base;
    }

    // YouTube Music: music.youtube.com/watch?v={id}
    if (host === 'music.youtube.com') {
      const v = parsed.searchParams.get('v');
      if (v && ID_RE.test(v)) return `https://music.youtube.com/watch?v=${v}`;
      return undefined;
    }

    // NetEase Cloud Music: music.163.com/#/song?id={id} or /song?id={id}
    if (host === 'music.163.com') {
      let id = parsed.searchParams.get('id');
      if (!id && parsed.hash) {
        const hashMatch = parsed.hash.match(/[?&]id=([0-9]+)/);
        if (hashMatch?.[1]) id = hashMatch[1];
      }
      if (id && NUMERIC_RE.test(id)) return `https://music.163.com/#/song?id=${id}`;
      return undefined;
    }

    // QQ Music: y.qq.com/n/ryqq/songDetail/{id}
    if (host === 'y.qq.com') {
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length > 0 && segments.every((s) => SLUG_RE.test(s))) {
        return `https://y.qq.com/${segments.join('/')}`;
      }
      return undefined;
    }

    // Yandex Music: music.yandex.{ru,com,...}/album/{albumId}/track/{trackId}
    if (/^music\.yandex\.(ru|com|by|kz|uz)$/.test(host)) {
      const match = pathname.match(/^\/album\/([0-9]+)\/track\/([0-9]+)/);
      if (match) return `https://${host}/album/${match[1]}/track/${match[2]}`;
      return undefined;
    }

    // TIDAL: tidal.com/track/{id} or tidal.com/browse/track/{id}
    if (hostIs(host, 'tidal.com')) {
      const match = pathname.match(/\/(?:browse\/)?track\/([0-9]+)/);
      if (match?.[1]) return `https://tidal.com/track/${match[1]}`;
      return undefined;
    }

    // Deezer: deezer.com/track/{id}
    if (hostIs(host, 'deezer.com')) {
      const match = pathname.match(/\/track\/([0-9]+)/);
      if (match?.[1]) return `https://www.deezer.com/track/${match[1]}`;
      return undefined;
    }

    // Bandcamp: {artist}.bandcamp.com/track/{slug}
    if (host.endsWith('.bandcamp.com')) {
      const sub = host.slice(0, -'.bandcamp.com'.length);
      const match = pathname.match(/^\/track\/([A-Za-z0-9._~%-]+)/);
      if (SUBDOMAIN_RE.test(sub) && match?.[1]) {
        return `https://${sub}.bandcamp.com/track/${match[1]}`;
      }
      return undefined;
    }

    // SoundCloud: soundcloud.com/{user}/{track}
    if (hostIs(host, 'soundcloud.com')) {
      const [user, track] = pathname.split('/').filter(Boolean);
      if (user && track && SLUG_RE.test(user) && SLUG_RE.test(track)) {
        return `https://soundcloud.com/${user}/${track}`;
      }
      return undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
