import { describe, it, expect } from 'vitest';
import { describeEnvironment } from './describeEnvironment';

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.3485.54',
  operaWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 OPR/123.0.0.0',
  firefoxLinux:
    'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
  firefoxMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.7 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  electronMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) backspace/1.5.1 Chrome/146.0.7680.31 Electron/43.0.0 Safari/537.36',
  electronWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) backspace/1.5.1 Chrome/146.0.7680.31 Electron/43.0.0 Safari/537.36',
} as const;

describe('describeEnvironment', () => {
  it.each([
    ['Chrome on Windows', UA.chromeWindows, 'Chrome 140 on Windows'],
    ['Edge on Windows', UA.edgeWindows, 'Edge 140 on Windows'],
    ['Opera on Windows', UA.operaWindows, 'Opera 123 on Windows'],
    ['Firefox on Linux', UA.firefoxLinux, 'Firefox 142 on Linux'],
    ['Firefox on macOS', UA.firefoxMac, 'Firefox 131 on macOS'],
    ['Safari on macOS', UA.safariMac, 'Safari 18 on macOS'],
    ['Safari on iPhone', UA.safariIphone, 'Safari 18 on iOS'],
    ['Safari on iPad', UA.safariIpad, 'Safari 17 on iOS'],
    ['Chrome on Android', UA.chromeAndroid, 'Chrome 140 on Android'],
    ['Chrome on ChromeOS', UA.chromeOs, 'Chrome 140 on ChromeOS'],
  ])('describes %s', (_label, userAgent, expected) => {
    expect(describeEnvironment(userAgent, false)).toBe(expected);
  });

  it('describes the desktop app on macOS by its Chrome engine', () => {
    expect(describeEnvironment(UA.electronMac, true)).toBe('Desktop app (Chrome 146) on macOS');
  });

  it('describes the desktop app on Windows by its Chrome engine', () => {
    expect(describeEnvironment(UA.electronWindows, true)).toBe('Desktop app (Chrome 146) on Windows');
  });

  it('describes the desktop app without an engine when the UA carries no Chrome token', () => {
    expect(describeEnvironment('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', true)).toBe('Desktop app on macOS');
  });

  it('names an unknown browser and drops an unknown OS', () => {
    expect(describeEnvironment('curl/8.7.1', false)).toBe('Unknown browser');
  });

  it('names an unknown browser on a known OS', () => {
    expect(describeEnvironment('Mozilla/5.0 (X11; Linux x86_64) SomeBrowser/1.0', false)).toBe('Unknown browser on Linux');
  });

  it('drops an unknown OS for a known browser', () => {
    expect(describeEnvironment('Mozilla/5.0 (Plan9) Gecko/20100101 Firefox/128.0', false)).toBe('Firefox 128');
  });

  it('handles an empty user agent', () => {
    expect(describeEnvironment('', false)).toBe('Unknown browser');
  });
});
