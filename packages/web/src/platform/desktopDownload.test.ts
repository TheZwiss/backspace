import { describe, it, expect } from 'vitest';
import {
  detectDesktopPlatform,
  buildDesktopDownloads,
  RELEASES_URL,
  type DetectedPlatform,
  type NavigatorLike,
} from './desktopDownload';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const FIREFOX_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const CHROME_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const FIREFOX_LINUX_ARM = 'Mozilla/5.0 (X11; Linux aarch64; rv:130.0) Gecko/20100101 Firefox/130.0';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';

function hints(values: Record<string, unknown>): (h: string[]) => Promise<Record<string, unknown>> {
  return () => Promise.resolve(values);
}

describe('detectDesktopPlatform', () => {
  it('reads Windows from client hints and asks for no architecture', async () => {
    const nav: NavigatorLike = {
      userAgent: CHROME_WINDOWS,
      userAgentData: { platform: 'Windows', mobile: false, getHighEntropyValues: hints({ architecture: 'x86', bitness: '64' }) },
    };
    expect(await detectDesktopPlatform(nav)).toEqual({ os: 'windows', arch: null, archGuessed: false });
  });

  it('reads Windows from the user agent when there are no hints', async () => {
    expect(await detectDesktopPlatform({ userAgent: FIREFOX_WINDOWS })).toEqual({
      os: 'windows',
      arch: null,
      archGuessed: false,
    });
  });

  it('reads macOS from the user agent and guesses Apple Silicon', async () => {
    expect(await detectDesktopPlatform({ userAgent: SAFARI_MAC, maxTouchPoints: 0 })).toEqual({
      os: 'mac',
      arch: 'arm64',
      archGuessed: true,
    });
  });

  it('reads the mac architecture from client hints saying arm', async () => {
    const nav: NavigatorLike = {
      userAgent: CHROME_MAC,
      maxTouchPoints: 0,
      userAgentData: { platform: 'macOS', mobile: false, getHighEntropyValues: hints({ architecture: 'arm', bitness: '64' }) },
    };
    expect(await detectDesktopPlatform(nav)).toEqual({ os: 'mac', arch: 'arm64', archGuessed: false });
  });

  it('reads the linux architecture from client hints saying x86 with bitness 64', async () => {
    const nav: NavigatorLike = {
      userAgent: CHROME_LINUX,
      userAgentData: { platform: 'Linux', mobile: false, getHighEntropyValues: hints({ architecture: 'x86', bitness: '64' }) },
    };
    expect(await detectDesktopPlatform(nav)).toEqual({ os: 'linux', arch: 'x64', archGuessed: false });
  });

  it('reads x86_64 out of a linux user agent', async () => {
    expect(await detectDesktopPlatform({ userAgent: FIREFOX_LINUX })).toEqual({
      os: 'linux',
      arch: 'x64',
      archGuessed: false,
    });
  });

  it('reads aarch64 out of a linux user agent', async () => {
    expect(await detectDesktopPlatform({ userAgent: FIREFOX_LINUX_ARM })).toEqual({
      os: 'linux',
      arch: 'arm64',
      archGuessed: false,
    });
  });

  it('treats Android as other', async () => {
    const nav: NavigatorLike = {
      userAgent: CHROME_ANDROID,
      userAgentData: { platform: 'Android', mobile: true, getHighEntropyValues: hints({ architecture: 'arm', bitness: '64' }) },
    };
    expect(await detectDesktopPlatform(nav)).toEqual({ os: 'other', arch: null, archGuessed: false });
  });

  it('treats an iPhone as other', async () => {
    expect(await detectDesktopPlatform({ userAgent: SAFARI_IPHONE })).toEqual({
      os: 'other',
      arch: null,
      archGuessed: false,
    });
  });

  it('treats an iPad reporting a Mac user agent as other', async () => {
    expect(await detectDesktopPlatform({ userAgent: SAFARI_MAC, maxTouchPoints: 5 })).toEqual({
      os: 'other',
      arch: null,
      archGuessed: false,
    });
  });

  it('lets the hint platform win over a disagreeing user agent', async () => {
    const nav: NavigatorLike = {
      userAgent: CHROME_WINDOWS,
      userAgentData: { platform: 'Linux', mobile: false },
    };
    expect(await detectDesktopPlatform(nav)).toEqual({ os: 'linux', arch: 'x64', archGuessed: false });
  });

  it('falls back to the user agent when the hint platform is not one it knows', async () => {
    const nav: NavigatorLike = {
      userAgent: CHROME_WINDOWS,
      userAgentData: { platform: 'Unknown', mobile: false },
    };
    expect(await detectDesktopPlatform(nav)).toEqual({ os: 'windows', arch: null, archGuessed: false });
  });

  it('falls back to the platform default when getHighEntropyValues rejects', async () => {
    const nav: NavigatorLike = {
      userAgent: CHROME_MAC,
      maxTouchPoints: 0,
      userAgentData: { platform: 'macOS', mobile: false, getHighEntropyValues: () => Promise.reject(new Error('denied')) },
    };
    expect(await detectDesktopPlatform(nav)).toEqual({ os: 'mac', arch: 'arm64', archGuessed: true });
  });

  it('falls back to the platform default when getHighEntropyValues throws synchronously', async () => {
    const nav: NavigatorLike = {
      userAgent: CHROME_MAC,
      maxTouchPoints: 0,
      userAgentData: {
        platform: 'macOS',
        mobile: false,
        getHighEntropyValues: () => {
          throw new Error('blocked');
        },
      },
    };
    expect(await detectDesktopPlatform(nav)).toEqual({ os: 'mac', arch: 'arm64', archGuessed: true });
  });

  it('falls through to the user agent when the hints carry an unusable architecture', async () => {
    const nav: NavigatorLike = {
      userAgent: FIREFOX_LINUX,
      userAgentData: { platform: 'Linux', mobile: false, getHighEntropyValues: hints({ architecture: 'x86', bitness: '32' }) },
    };
    expect(await detectDesktopPlatform(nav)).toEqual({ os: 'linux', arch: 'x64', archGuessed: false });
  });
});

const VERSION = '1.2.1';
const BASE = `${RELEASES_URL}/download/v${VERSION}/`;

function platform(os: DetectedPlatform['os'], arch: DetectedPlatform['arch']): DetectedPlatform {
  return { os, arch, archGuessed: false };
}

function names(downloads: { filename: string }[]): string[] {
  return downloads.map((d) => d.filename);
}

describe('buildDesktopDownloads', () => {
  it('names the seven builds electron-builder emits', () => {
    const links = buildDesktopDownloads(VERSION, platform('other', null));
    expect(links.primary).toBeNull();
    expect(names(links.others).slice().sort()).toEqual(
      [
        'Backspace-1.2.1.exe',
        'Backspace-1.2.1-arm64.dmg',
        'Backspace-1.2.1-x64.dmg',
        'Backspace-1.2.1-x86_64.AppImage',
        'Backspace-1.2.1-arm64.AppImage',
        'Backspace-1.2.1-amd64.deb',
        'Backspace-1.2.1-arm64.deb',
      ].sort(),
    );
    for (const download of links.others) {
      expect(download.url).toBe(`${BASE}${download.filename}`);
    }
    expect(links.allReleasesUrl).toBe(RELEASES_URL);
  });

  it('offers the combined installer on windows and defaults the other platforms', () => {
    const links = buildDesktopDownloads(VERSION, platform('windows', null));
    expect(links.primary).toEqual({
      os: 'windows',
      arch: null,
      kind: 'exe',
      filename: 'Backspace-1.2.1.exe',
      url: `${BASE}Backspace-1.2.1.exe`,
    });
    expect(names(links.others)).toEqual([
      'Backspace-1.2.1-arm64.dmg',
      'Backspace-1.2.1-x64.dmg',
      'Backspace-1.2.1-x86_64.AppImage',
      'Backspace-1.2.1-amd64.deb',
      'Backspace-1.2.1-arm64.AppImage',
      'Backspace-1.2.1-arm64.deb',
    ]);
  });

  it('offers the arm dmg on an Apple Silicon mac', () => {
    const links = buildDesktopDownloads(VERSION, platform('mac', 'arm64'));
    expect(links.primary?.filename).toBe('Backspace-1.2.1-arm64.dmg');
    expect(links.primary?.kind).toBe('dmg');
    // The visitor's own platform is exhausted first, then windows, mac, linux.
    expect(names(links.others)).toEqual([
      'Backspace-1.2.1-x64.dmg',
      'Backspace-1.2.1.exe',
      'Backspace-1.2.1-arm64.AppImage',
      'Backspace-1.2.1-arm64.deb',
      'Backspace-1.2.1-x86_64.AppImage',
      'Backspace-1.2.1-amd64.deb',
    ]);
  });

  it('offers the intel dmg on an intel mac', () => {
    const links = buildDesktopDownloads(VERSION, platform('mac', 'x64'));
    expect(links.primary?.filename).toBe('Backspace-1.2.1-x64.dmg');
    expect(names(links.others)).toEqual([
      'Backspace-1.2.1-arm64.dmg',
      'Backspace-1.2.1.exe',
      'Backspace-1.2.1-x86_64.AppImage',
      'Backspace-1.2.1-amd64.deb',
      'Backspace-1.2.1-arm64.AppImage',
      'Backspace-1.2.1-arm64.deb',
    ]);
  });

  it('offers the x64 AppImage on linux and puts the matching deb first', () => {
    const links = buildDesktopDownloads(VERSION, platform('linux', 'x64'));
    expect(links.primary).toEqual({
      os: 'linux',
      arch: 'x64',
      kind: 'appimage',
      filename: 'Backspace-1.2.1-x86_64.AppImage',
      url: `${BASE}Backspace-1.2.1-x86_64.AppImage`,
    });
    expect(names(links.others)).toEqual([
      'Backspace-1.2.1-amd64.deb',
      'Backspace-1.2.1-arm64.AppImage',
      'Backspace-1.2.1-arm64.deb',
      'Backspace-1.2.1.exe',
      'Backspace-1.2.1-x64.dmg',
      'Backspace-1.2.1-arm64.dmg',
    ]);
  });

  it('offers the arm AppImage on arm linux', () => {
    const links = buildDesktopDownloads(VERSION, platform('linux', 'arm64'));
    expect(links.primary?.filename).toBe('Backspace-1.2.1-arm64.AppImage');
    expect(names(links.others)).toEqual([
      'Backspace-1.2.1-arm64.deb',
      'Backspace-1.2.1-x86_64.AppImage',
      'Backspace-1.2.1-amd64.deb',
      'Backspace-1.2.1.exe',
      'Backspace-1.2.1-arm64.dmg',
      'Backspace-1.2.1-x64.dmg',
    ]);
  });

  it('points every link at the releases page for a version that is not major.minor.patch', () => {
    const links = buildDesktopDownloads('0.0.0-dev', platform('linux', 'x64'));
    expect(links.primary?.url).toBe(RELEASES_URL);
    expect(links.others).toHaveLength(6);
    for (const download of links.others) {
      expect(download.url).toBe(RELEASES_URL);
    }
    expect(links.allReleasesUrl).toBe(RELEASES_URL);
  });

  it('points every link at the releases page for an empty version', () => {
    const links = buildDesktopDownloads('', platform('other', null));
    expect(links.others).toHaveLength(7);
    for (const download of links.others) {
      expect(download.url).toBe(RELEASES_URL);
    }
  });
});
