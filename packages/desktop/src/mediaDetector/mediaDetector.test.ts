import { describe, expect, it } from 'vitest';
import { sanitizeTrackUrl } from './trackUrl';
import { isAppIdleTitle, parsePlayerWindowTitle } from './titleParser';
import { convertTrackToActivity, nextMediaTimeline } from './index';
import {
  decodeWin32Output,
  parseSmtcOutput,
  selectSmtcTrack,
  selectNetEaseFallbackTrack,
  resolvePlayerFromAppId,
  isBrowserPlayer,
  shouldRequestNetEaseSetup,
  type SmtcProbeResult,
} from './win32Media';
import { parseMprisMetadata, getPlayerDisplayName } from './linuxMpris';

describe('Media Detector - Canonical Track URLs', () => {
  it('normalizes Spotify URI to open.spotify.com URL', () => {
    expect(sanitizeTrackUrl('spotify:track:4cOdK2wGLETKBW3PvgPWqT')).toBe(
      'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
    );
  });

  it('strips tracking query parameters from Spotify URLs', () => {
    expect(
      sanitizeTrackUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123xyz'),
    ).toBe('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  });

  it('preserves NetEase song id', () => {
    expect(sanitizeTrackUrl('https://music.163.com/#/song?id=186016&userid=999')).toBe(
      'https://music.163.com/#/song?id=186016',
    );
  });

  it('preserves Apple Music track param i', () => {
    expect(
      sanitizeTrackUrl('https://music.apple.com/us/album/easy-on-me/1590035691?i=1590036033&extra=123'),
    ).toBe('https://music.apple.com/us/album/easy-on-me/1590035691?i=1590036033');
  });

  it('preserves YouTube Music video parameter v', () => {
    expect(
      sanitizeTrackUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&si=abc'),
    ).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('rejects general non-music URLs', () => {
    expect(sanitizeTrackUrl('https://github.com/TheZwiss/backspace')).toBeUndefined();
    expect(sanitizeTrackUrl('https://google.com')).toBeUndefined();
  });

  it('rejects look-alike hosts that merely contain a music domain', () => {
    expect(sanitizeTrackUrl('https://music.apple.com.evil.tld/us/album/x/1?i=2')).toBeUndefined();
    expect(sanitizeTrackUrl('https://evilapple.com/us/album/x/1')).toBeUndefined();
    expect(sanitizeTrackUrl('https://x.apple.com/us/album/x/1')).toBeUndefined();
    expect(sanitizeTrackUrl('https://notspotify.com/track/abc')).toBeUndefined();
    expect(sanitizeTrackUrl('https://open.spotify.com.evil.tld/track/abc')).toBeUndefined();
    expect(sanitizeTrackUrl('https://qq.com.evil.tld/n/ryqq/songDetail/1')).toBeUndefined();
    expect(sanitizeTrackUrl('https://music.yandex.evil.tld/album/1/track/2')).toBeUndefined();
    expect(sanitizeTrackUrl('https://evil.tld/.bandcamp.com/track/x')).toBeUndefined();
    expect(sanitizeTrackUrl('https://music.163.com.evil.tld/#/song?id=1')).toBeUndefined();
  });

  it('rejects non-http schemes and malformed identifiers', () => {
    expect(sanitizeTrackUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeTrackUrl('file:///etc/passwd')).toBeUndefined();
    expect(sanitizeTrackUrl('https://music.youtube.com/watch?v=a"onmouseover="x')).toBeUndefined();
    expect(sanitizeTrackUrl('https://music.apple.com/us/album/x/1?i=12abc')).toBe(
      'https://music.apple.com/us/album/x/1',
    );
    expect(sanitizeTrackUrl('https://music.163.com/#/song?id=abc')).toBeUndefined();
  });

  it('keeps genuine hosts of the other services', () => {
    expect(sanitizeTrackUrl('https://music.yandex.ru/album/123/track/456?utm=1')).toBe(
      'https://music.yandex.ru/album/123/track/456',
    );
    expect(sanitizeTrackUrl('https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV')).toBe(
      'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV',
    );
    expect(sanitizeTrackUrl('https://artist.bandcamp.com/track/some-song?from=x')).toBe(
      'https://artist.bandcamp.com/track/some-song',
    );
    expect(sanitizeTrackUrl('https://soundcloud.com/user/track?si=1')).toBe(
      'https://soundcloud.com/user/track',
    );
    expect(sanitizeTrackUrl('https://listen.tidal.com/browse/track/123')).toBe(
      'https://tidal.com/track/123',
    );
    expect(sanitizeTrackUrl('https://www.deezer.com/en/track/789')).toBe(
      'https://www.deezer.com/track/789',
    );
  });
});

describe('Media Detector - Window Title Parser', () => {
  it('detects idle status for players', () => {
    expect(isAppIdleTitle('cloudmusic', '网易云音乐')).toBe(true);
    expect(isAppIdleTitle('cloudmusic', '桌面歌词')).toBe(true);
    expect(isAppIdleTitle('qqmusic', 'QQ音乐')).toBe(true);
    expect(isAppIdleTitle('qqmusic', '桌面歌词')).toBe(true);
    expect(isAppIdleTitle('kugou', '桌面歌词')).toBe(true);
    expect(isAppIdleTitle('spotify', 'Spotify Free')).toBe(true);
    expect(isAppIdleTitle('spotify', 'Spotify Premium')).toBe(true);
    expect(isAppIdleTitle('yandexmusic', 'Яндекс Музыка')).toBe(true);
    expect(isAppIdleTitle('cloudmusic', 'N/A')).toBe(true);
    expect(isAppIdleTitle('cloudmusic', '暂缺')).toBe(true);
    expect(isAppIdleTitle('qqmusic', 'QQ音乐，听我想听的歌')).toBe(true);
  });

  it('supports dash variants (em-dash, en-dash, fullwidth dash)', () => {
    expect(parsePlayerWindowTitle('cloudmusic', '告白气球 – 周杰伦')).toEqual({
      title: '告白气球',
      artist: '周杰伦',
    });
    expect(parsePlayerWindowTitle('cloudmusic', '青花瓷 — 周杰伦')).toEqual({
      title: '青花瓷',
      artist: '周杰伦',
    });
    expect(parsePlayerWindowTitle('cloudmusic', '稻香 － 周杰伦')).toEqual({
      title: '稻香',
      artist: '周杰伦',
    });
    expect(parsePlayerWindowTitle('spotify', 'Taylor Swift — Blank Space')).toEqual({
      artist: 'Taylor Swift',
      title: 'Blank Space',
    });
  });

  it('parses NetEase Cloud Music title and artist (and strips player prefix if present)', () => {
    const res = parsePlayerWindowTitle('cloudmusic', '海阔天空 - Beyond');
    expect(res).toEqual({ title: '海阔天空', artist: 'Beyond' });

    const prefixed = parsePlayerWindowTitle('cloudmusic', '网易云音乐 - 晴天 - 周杰伦');
    expect(prefixed).toEqual({ title: '晴天', artist: '周杰伦' });
  });

  it('parses QQ Music title and artist', () => {
    const res = parsePlayerWindowTitle('qqmusic', '晴天 - 周杰伦');
    expect(res).toEqual({ title: '晴天', artist: '周杰伦' });
  });

  it('parses Spotify "Artist - Title" format', () => {
    const res = parsePlayerWindowTitle('spotify', 'Adele - Easy On Me');
    expect(res).toEqual({ artist: 'Adele', title: 'Easy On Me' });
  });

  it('parses Yandex Music and removes app suffix', () => {
    const res = parsePlayerWindowTitle('yandexmusic', 'Группа крови - Кино - Яндекс Музыка');
    expect(res).toEqual({ title: 'Группа крови', artist: 'Кино' });
  });

  it('parses KuGou Music format', () => {
    const res = parsePlayerWindowTitle('kugou', '周深 - 大鱼');
    expect(res).toEqual({ artist: '周深', title: '大鱼' });
  });

  it('returns null on idle app windows', () => {
    expect(parsePlayerWindowTitle('cloudmusic', '网易云音乐')).toBeNull();
    expect(parsePlayerWindowTitle('spotify', 'Spotify')).toBeNull();
  });
});

describe('Media Detector - Win32 Output Decoding', () => {
  it('correctly decodes GBK/CP936 bytes to prevent Chinese mojibake', () => {
    // "海阔天空" in GBK hex: ba a3 c0 ab cc ec bf d5
    const gbkBytes = Buffer.concat([
      Buffer.from('"foobar2000.exe","123","Console","1","50 K","Running","User","0:01:23","'),
      Buffer.from('baa3c0abccecbfd5', 'hex'),
      Buffer.from(' - Beyond"'),
    ]);
    const decoded = decodeWin32Output(gbkBytes);
    expect(decoded).toContain('海阔天空 - Beyond');
  });
});

describe('Media Detector - Linux MPRIS Parser', () => {
  it('formats player display names', () => {
    expect(getPlayerDisplayName('org.mpris.MediaPlayer2.spotify')).toBe('Spotify');
    expect(getPlayerDisplayName('org.mpris.MediaPlayer2.netease-cloud-music')).toBe('网易云音乐');
    expect(getPlayerDisplayName('org.mpris.MediaPlayer2.qqmusic')).toBe('QQ音乐');
  });

  it('parses MPRIS metadata dictionary', () => {
    const metadata = {
      'xesam:title': { value: 'Bohemian Rhapsody' },
      'xesam:artist': { value: ['Queen'] },
      'xesam:album': { value: 'A Night at the Opera' },
      'mpris:length': { value: 354000000 }, // 354 seconds in microseconds
      'mpris:artUrl': { value: 'https://i.scdn.co/image/ab67616d0000b273ce4f0f67' },
      'xesam:url': { value: 'https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J' },
    };

    const track = parseMprisMetadata(metadata, 'Spotify');
    expect(track).toEqual({
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      album: 'A Night at the Opera',
      artUrl: 'https://i.scdn.co/image/ab67616d0000b273ce4f0f67',
      durationMs: 354000,
      isPlaying: true,
      player: 'Spotify',
      sourceUrl: 'https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J',
    });
  });
});

describe('Media Detector - Activity Conversion', () => {
  it('converts MediaTrackInfo to listening Activity with duration and timestamps', () => {
    const now = Date.now();
    const track = {
      title: '光辉岁月',
      artist: 'Beyond',
      album: '命运派对',
      durationMs: 300000, // 5 min
      positionMs: 60000,  // 1 min in
      isPlaying: true,
      player: '网易云音乐',
      sourceUrl: 'https://music.163.com/#/song?id=347230',
    };

    const activity = convertTrackToActivity(track);
    expect(activity).not.toBeNull();
    expect(activity?.type).toBe('listening');
    expect(activity?.name).toBe('光辉岁月');
    expect(activity?.details).toBe('Beyond');
    expect(activity?.state).toBe('命运派对');
    expect(activity?.assets?.smallText).toBe('网易云音乐');
    expect(activity?.url).toBe('https://music.163.com/#/song?id=347230');

    // Timestamps check: start should be roughly now - 60s, end should be start + 300s
    expect(activity?.timestamps?.start).toBeCloseTo(now - 60000, -2);
    expect(activity?.timestamps?.end).toBeCloseTo(now - 60000 + 300000, -2);
    expect(activity?.playback).toEqual({ positionMs: 60000, durationMs: 300000 });
  });

  it('calculates single-track start and end timestamps from position and duration, resetting on track change', () => {
    const now = Date.now();
    const trackA = {
      title: 'Song A',
      artist: 'Artist A',
      durationMs: 200000,
      positionMs: 50000,
      isPlaying: true,
      player: 'NetEase Cloud Music',
    };
    const activityA = convertTrackToActivity(trackA);
    expect(activityA?.name).toBe('Song A');
    expect(activityA?.timestamps?.start).toBeCloseTo(now - 50000, -2);
    expect(activityA?.timestamps?.end).toBeCloseTo(now - 50000 + 200000, -2);

    const trackB = {
      title: 'Song B',
      artist: 'Artist B',
      durationMs: 180000,
      positionMs: 0,
      isPlaying: true,
      player: 'NetEase Cloud Music',
    };
    const activityB = convertTrackToActivity(trackB);
    expect(activityB?.name).toBe('Song B');
    expect(activityB?.timestamps?.start).toBeCloseTo(now, -2);
    expect(activityB?.timestamps?.end).toBeCloseTo(now + 180000, -2);
  });

  it('keeps a stable start when Chrome repeats a zero timeline snapshot', () => {
    const track = {
      title: 'Video',
      artist: 'Creator',
      positionMs: 0,
      durationMs: 300000,
      isPlaying: true,
      player: 'Chrome',
      mediaType: 'video' as const,
    };

    const first = nextMediaTimeline(null, track, 1_000);
    const repeated = nextMediaTimeline(first, track, 6_000);
    const advanced = nextMediaTimeline(repeated, { ...track, positionMs: 6_000 }, 7_000);
    const sought = nextMediaTimeline(advanced, { ...track, positionMs: 60_000 }, 8_000);

    expect(repeated.start).toBe(1_000);
    expect(advanced.start).toBe(1_000);
    expect(sought.start).toBe(-52_000);
  });

  it('keeps the same Chrome timeline when SMTC changes its media type', () => {
    const track = {
      title: 'Video',
      artist: 'Creator',
      positionMs: 0,
      durationMs: 300000,
      isPlaying: true,
      player: 'Chrome',
      mediaType: 'music' as const,
    };

    const first = nextMediaTimeline(null, track, 1_000);
    const changedType = nextMediaTimeline(first, {
      ...track,
      mediaType: 'video',
    }, 8_000);
    const repeatedZero = nextMediaTimeline(changedType, {
      ...track,
      mediaType: 'music',
    }, 16_000);

    expect(changedType.start).toBe(1_000);
    expect(repeatedZero.start).toBe(1_000);
  });

  it('does not re-anchor a normally advancing Chrome timeline', () => {
    const track = {
      title: 'Video',
      artist: 'Creator',
      positionMs: 0,
      durationMs: 300000,
      isPlaying: true,
      player: 'Chrome',
      mediaType: 'video' as const,
    };

    const first = nextMediaTimeline(null, track, 1_000);
    const advanced = nextMediaTimeline(first, { ...track, positionMs: 8_000 }, 9_000);

    expect(advanced.start).toBe(1_000);
  });

  it('uses a stable timeline start when converting later track snapshots', () => {
    const timelineStart = Date.now() - 60000;
    const activity = convertTrackToActivity({
      title: 'Video',
      artist: 'Creator',
      positionMs: 0,
      durationMs: 300000,
      isPlaying: true,
      player: 'Chrome',
      mediaType: 'video',
    }, timelineStart);

    expect(activity?.timestamps?.start).toBe(timelineStart);
    expect(activity?.timestamps?.end).toBe(timelineStart + 300000);
    expect(activity?.playback).toEqual({ positionMs: 60000, durationMs: 300000 });
  });

  it('converts track with mediaType video to watching activity', () => {
    const track = {
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      isPlaying: true,
      player: 'Chrome',
      mediaType: 'video' as const,
    };
    const activity = convertTrackToActivity(track);
    expect(activity).not.toBeNull();
    expect(activity?.type).toBe('watching');
    expect(activity?.name).toBe('Never Gonna Give You Up');
    expect(activity?.details).toBe('Rick Astley');
    expect(activity?.assets?.smallText).toBe('Chrome');
  });
});

describe('Media Detector - Win32 SMTC Parser', () => {
  const smtcResult = (overrides: Partial<SmtcProbeResult> = {}): SmtcProbeResult => ({
    ok: true,
    sessions: [],
    netEase: {
      running: true,
      windowTitle: '七里香 - 周杰伦',
    },
    ...overrides,
  });

  it('parses every SMTC session with its playback status and metadata', () => {
    const res = parseSmtcOutput(JSON.stringify({
      ok: true,
      sessions: [
        {
          appId: 'cloudmusic.exe',
          status: 4,
          title: '七里香',
          artist: '周杰伦',
          mediaType: 'music',
          positionMs: 83000,
          durationMs: 240000,
          timelineUpdatedAtMs: 1760000000000,
        },
        {
          appId: 'chrome.exe',
          status: 5,
          title: 'Paused video',
          artist: '',
          mediaType: 'video',
        },
      ],
    }));

    expect(res).toEqual({
      ok: true,
      sessions: [
        {
          appId: 'cloudmusic.exe',
          player: 'NetEase Cloud Music',
          status: 'playing',
          title: '七里香',
          artist: '周杰伦',
          positionMs: 83000,
          durationMs: 240000,
          timelineUpdatedAtMs: 1760000000000,
          mediaType: 'music',
        },
        {
          appId: 'chrome.exe',
          player: 'Chrome',
          status: 'paused',
          title: 'Paused video',
          artist: '',
          positionMs: undefined,
          durationMs: undefined,
          mediaType: 'video',
        },
      ],
    });
  });

  it('selects only playing sessions and prefers a dedicated player over a browser', () => {
    const res = parseSmtcOutput(JSON.stringify({
      ok: true,
      sessions: [
        {
          appId: 'chrome.exe',
          status: 4,
          title: 'Browser video',
          artist: 'Creator',
          mediaType: 'video',
        },
        {
          appId: 'cloudmusic.exe',
          status: 4,
          title: '海阔天空',
          artist: 'Beyond',
          mediaType: 'music',
        },
      ],
    }));

    expect(selectSmtcTrack(res)).toMatchObject({
      title: '海阔天空',
      artist: 'Beyond',
      player: 'NetEase Cloud Music',
      isPlaying: true,
      mediaType: 'music',
    });

    const paused = parseSmtcOutput(JSON.stringify({
      ok: true,
      sessions: [{
        appId: 'cloudmusic.exe',
        status: 5,
        title: '海阔天空',
        artist: 'Beyond',
        mediaType: 'music',
      }],
    }));
    expect(selectSmtcTrack(paused)).toBeNull();
  });

  it('extrapolates the SMTC timeline snapshot to the current playback position', () => {
    const res = parseSmtcOutput(JSON.stringify({
      ok: true,
      sessions: [{
        appId: 'cloudmusic.exe',
        status: 4,
        title: '七里香',
        artist: '周杰伦',
        mediaType: 'music',
        positionMs: 83000,
        durationMs: 240000,
        timelineUpdatedAtMs: 1000,
      }],
    }));

    expect(selectSmtcTrack(res, 6000)?.positionMs).toBe(88000);
  });

  it('clamps extrapolated playback position to the track duration', () => {
    const res = parseSmtcOutput(JSON.stringify({
      ok: true,
      sessions: [{
        appId: 'cloudmusic.exe',
        status: 4,
        title: '七里香',
        artist: '周杰伦',
        mediaType: 'music',
        positionMs: 238000,
        durationMs: 240000,
        timelineUpdatedAtMs: 1000,
      }],
    }));

    expect(selectSmtcTrack(res, 6000)?.positionMs).toBe(240000);
  });

  it('reports monitor failures instead of treating them as paused', () => {
    expect(parseSmtcOutput('not json')).toEqual({
      ok: false,
      sessions: [],
      error: 'SMTC monitor returned no JSON',
    });
    expect(parseSmtcOutput(JSON.stringify({
      ok: false,
      sessions: [],
      error: 'WinRT unavailable',
    }))).toEqual({
      ok: false,
      sessions: [],
      error: 'WinRT unavailable',
    });
  });

  it('parses NetEase process and window-title diagnostics', () => {
    const res = parseSmtcOutput(JSON.stringify({
      ok: true,
      sessions: [],
      netEase: {
        running: true,
        windowTitle: '七里香 - 周杰伦',
      },
    }));

    expect(res).toEqual({
      ok: true,
      sessions: [],
      netEase: {
        running: true,
        windowTitle: '七里香 - 周杰伦',
      },
    });
  });

  it('requests SMTC setup only when NetEase is running with a song title and no SMTC session', () => {
    expect(shouldRequestNetEaseSetup(smtcResult())).toBe(true);
    expect(shouldRequestNetEaseSetup(smtcResult({
      sessions: [{
        appId: 'cloudmusic.exe',
        player: 'NetEase Cloud Music',
        status: 'paused',
        title: '七里香',
        artist: '周杰伦',
        mediaType: 'music',
      }],
    }))).toBe(false);
    expect(shouldRequestNetEaseSetup(smtcResult({
      netEase: { running: true, windowTitle: '网易云音乐' },
    }))).toBe(false);
    expect(shouldRequestNetEaseSetup(smtcResult({
      netEase: { running: false, windowTitle: '七里香 - 周杰伦' },
    }))).toBe(false);
    expect(shouldRequestNetEaseSetup(smtcResult({ ok: false }))).toBe(false);
  });

  it('keeps a degraded NetEase listening status when SMTC is off', () => {
    expect(selectNetEaseFallbackTrack(smtcResult())).toEqual({
      title: '七里香',
      artist: '周杰伦',
      isPlaying: true,
      player: 'NetEase Cloud Music',
    });
    expect(selectNetEaseFallbackTrack(smtcResult({
      sessions: [{
        appId: 'cloudmusic.exe',
        player: 'NetEase Cloud Music',
        status: 'paused',
        title: '',
        artist: '',
        mediaType: 'music',
      }],
    }))).toBeNull();
    expect(selectNetEaseFallbackTrack(smtcResult({
      netEase: { running: true, windowTitle: '网易云音乐' },
    }))).toBeNull();
  });

  it('correctly classifies browser players vs dedicated music players', () => {
    expect(isBrowserPlayer('Chrome')).toBe(true);
    expect(isBrowserPlayer('Edge')).toBe(true);
    expect(isBrowserPlayer('Firefox')).toBe(true);
    expect(isBrowserPlayer('Brave')).toBe(true);
    expect(isBrowserPlayer('Opera')).toBe(true);
    expect(isBrowserPlayer('Vivaldi')).toBe(true);

    expect(isBrowserPlayer('NetEase Cloud Music')).toBe(false);
    expect(isBrowserPlayer('QQ Music')).toBe(false);
    expect(isBrowserPlayer('Spotify')).toBe(false);
    expect(isBrowserPlayer('Apple Music')).toBe(false);
    expect(isBrowserPlayer('foobar2000')).toBe(false);
    expect(isBrowserPlayer(undefined)).toBe(false);
  });

  it('resolves player names from AppUserModelId', () => {
    expect(resolvePlayerFromAppId('cloudmusic.exe')).toBe('NetEase Cloud Music');
    expect(resolvePlayerFromAppId('Netease.163Music_abc')).toBe('NetEase Cloud Music');
    expect(resolvePlayerFromAppId('QQMusic.exe')).toBe('QQ Music');
    expect(resolvePlayerFromAppId('Spotify.exe')).toBe('Spotify');
    expect(resolvePlayerFromAppId('AppleMusic_abc123')).toBe('Apple Music');
  });
});
